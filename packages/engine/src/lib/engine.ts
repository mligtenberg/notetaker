import type { ProcessMeetingOptions } from './process-meeting-options';
import type { Meeting } from './models/meeting';
import type { MeetingNotes } from './models/meeting-notes';
import { PipelineFactory } from './pipeline-factory';
import type { MeetingAudio } from './models/meeting-audio';
import type { SpeakerTurn } from './models/speaker-turn';
import type { TranscriptSegment } from './models/transcript-segment';
import { ModelManager, type ManagedModel } from '@notetaker/model-manager';
import {
  AutomaticSpeechRecognitionPipeline,
  AutoModelForCTC,
  AutoModelForAudioFrameClassification,
  AutoProcessor,
  AutoTokenizer,
  Tensor,
  WhisperTextStreamer,
  read_audio,
} from '@huggingface/transformers';
import type { TimestampedText } from './models/timestamped-text';

type TimestampedWord = { word: string; timestampInMs: number };
type AudioInput = string | URL | Float32Array | Float64Array;
type CallablePipeline = (input: unknown, options?: unknown) => Promise<unknown>;

type CtcWord = { text: string; startSeconds: number };

type CtcTokenizer = {
  all_special_ids?: number[];
  pad_token_id?: number;
  word_delimiter_token?: string;
  get_vocab(): Map<string, number>;
};

type TensorLike = {
  data: ArrayLike<number>;
  dims: number[];
};

const TRANSCRIPTION_CHUNK_SECONDS = 30;
const TRANSCRIPTION_STRIDE_SECONDS = 5;
// transformers.js advances each chunk by `window - 2 * stride` seconds
// (see pipelines/automatic-speech-recognition.js).
const TRANSCRIPTION_CHUNK_ADVANCE_SECONDS =
  TRANSCRIPTION_CHUNK_SECONDS - 2 * TRANSCRIPTION_STRIDE_SECONDS;
const DIARIZATION_CHUNK_SECONDS = 60;
const DIARIZATION_MIN_CHUNK_SECONDS = 0.25;
const DIARIZATION_OVERLAP_SECONDS = 30;
const DIARIZATION_MIN_TURN_SECONDS = 1.25;
const DIARIZATION_SMOOTHING_GAP_SECONDS = 0.75;
const ALIGNMENT_CHUNK_SECONDS = 10;
const SPEAKER_NAMING_SEGMENT_CHUNK_SIZE = 50;
const SPEAKER_NAMING_SEGMENT_CHUNK_OVERLAP = 3;

type DiarizationOptions = {
  speakerCountHint?: number | null;
  debug?: (line: string) => void;
};

type DiarizationStitchingState = {
  speakerIndex: number;
  turns: SpeakerTurn[];
};

type TranscriptionChunk = {
  text?: string;
  timestamp?: [number | null, number | null] | null;
};

type TranscriptionResult =
  | string
  | {
      text?: string;
      chunks?: TranscriptionChunk[];
    };

type TextGenerationResult =
  | string
  | { generated_text?: string }
  | { generated_text?: string }[];

export class Engine {
  constructor(
    private pipelineFactory: PipelineFactory,
    private modelManager: ModelManager,
  ) {}

  async processMeeting(
    meeting: Meeting,
    options: ProcessMeetingOptions = {},
  ): Promise<MeetingNotes> {
    const emit = options.onProgress;
    const debug = options.onDebug;
    const timestampedFragments: TimestampedText[] = [];

    emit?.({ stage: 'transcription', status: 'started' });
    const transcriptText = await this.transcribeAudio(
      meeting.audio,
      (fragments) => {
        timestampedFragments.splice(
          0,
          timestampedFragments.length,
          ...fragments,
        );
        options.onPartialTranscript?.(timestampedFragments);
      },
      debug,
    );
    emit?.({ stage: 'transcription', status: 'completed' });

    emit?.({ stage: 'diarization', status: 'started' });
    const speakerTurns = await this.diarizeAudio(meeting.audio, {
      speakerCountHint: options.speakerCountHint,
      debug,
    });
    const alignedWords = await this.alignTranscriptToAudio(
      transcriptText,
      meeting.audio,
      debug,
    );
    emit?.({ stage: 'diarization', status: 'completed' });

    const segments = this.#buildSegments(
      transcriptText,
      timestampedFragments,
      alignedWords,
      speakerTurns,
    );

    emit?.({ stage: 'speaker-naming', status: 'started' });
    const speakerNames = new Map<string, string>(); //await this.#nameSpeakers(meeting, segments);
    emit?.({ stage: 'speaker-naming', status: 'completed' });

    return {
      meeting,
      transcript: {
        text: transcriptText,
        segments: segments.map((segment) => ({
          ...segment,
          speakerName: speakerNames.get(segment.speaker) ?? segment.speaker,
        })),
      },
    };
  }

  /**
   * Detects the spoken language of an audio sample using the active multilingual
   * Whisper model. Returns an ISO language code (e.g. 'en', 'nl') or null if the
   * active model is English-only or detection fails.
   */
  async detectAudioLanguage(
    meetingAudio: MeetingAudio,
    options: { sampleSeconds?: number; debug?: (line: string) => void } = {},
  ): Promise<string | null> {
    const debug = options.debug;
    const sampleSeconds = options.sampleSeconds ?? 30;
    debug?.('[language-detection] loading Whisper pipeline...');
    const pipeline = (await this.#getPipelineForActiveModel(
      'transcription',
    )) as AutomaticSpeechRecognitionPipeline;
    const model = (pipeline as unknown as { model: any }).model;
    const processor = (pipeline as unknown as { processor: any }).processor;
    const generationConfig = model?.generation_config;
    const langToId = generationConfig?.lang_to_id as
      | Record<string, number>
      | undefined;

    if (!generationConfig?.is_multilingual || !langToId) {
      debug?.(
        '[language-detection] active Whisper model is English-only or lacks language tokens; skipping.',
      );
      return null;
    }

    const sampleRate =
      processor.feature_extractor?.config?.sampling_rate ?? 16_000;
    const readAudio = read_audio as unknown as (
      input: unknown,
      sampleRate: number,
    ) => Promise<Float32Array>;
    const rawAudio = await this.#withAudioInput(meetingAudio, (audioInput) =>
      audioInput instanceof Float32Array
        ? Promise.resolve(audioInput)
        : readAudio(audioInput, sampleRate),
    );
    const audio = this.#sanitizeAudioSamples(rawAudio);

    if (audio.length === 0) {
      debug?.('[language-detection] no audio samples; skipping.');
      return null;
    }

    const sampleLength = Math.min(
      audio.length,
      Math.floor(sampleSeconds * sampleRate),
    );
    const audioSample = audio.subarray(0, sampleLength);
    debug?.(
      `[language-detection] using ${(sampleLength / sampleRate).toFixed(2)}s audio sample.`,
    );

    const inputs = await processor(audioSample);
    const sotToken = generationConfig.decoder_start_token_id;
    const decoderInputIds = new Tensor(
      'int64',
      BigInt64Array.from([BigInt(sotToken)]),
      [1, 1],
    );
    const output = (await model.generate({
      ...inputs,
      decoder_input_ids: decoderInputIds,
      max_new_tokens: 1,
    })) as TensorLike;

    const tokens = Array.from(output.data);
    const langTokenId = Number(tokens[tokens.length - 1]);
    const langToken = Object.keys(langToId).find(
      (key) => langToId[key] === langTokenId,
    );

    if (langToken === undefined) {
      debug?.(
        `[language-detection] no language token matches id ${langTokenId}.`,
      );
      return null;
    }

    const language = langToken.replace(/^<\|/, '').replace(/\|>$/, '');
    debug?.(`[language-detection] detected language: ${language}`);
    return language;
  }

  /**
   * Generates a transcript of a given audio file.
   */
  async transcribeAudio(
    meetingAudio: MeetingAudio,
    fragmentCallback: (fragments: TimestampedText[]) => void,
    debug?: (line: string) => void,
    language?: string,
    task?: 'transcribe' | 'translate',
  ): Promise<string> {
    debug?.(
      `[transcription] input ${this.#describeMeetingAudio(meetingAudio)}`,
    );
    debug?.('[transcription] loading Whisper pipeline...');
    const pipeline = (await this.#getPipelineForActiveModel(
      'transcription',
    )) as AutomaticSpeechRecognitionPipeline;
    debug?.('[transcription] Whisper pipeline ready.');
    let emittedLiveTranscript = false;
    const streamedFragments: TimestampedText[] = [];
    let pendingStreamedText = '';
    let currentChunkStartSeconds = 0;
    // The Whisper streamer's on_chunk_start/on_chunk_end fire per
    // timestamp-token pair (segment-level). The reliable per-audio-chunk
    // boundary is on_finalize, which fires once per model.generate() call
    // (one call per 30s audio chunk).
    let audioChunkIndex = 0;
    const tokenizer = (pipeline as { tokenizer?: unknown }).tokenizer;

    debug?.(
      `[transcription] tokenizer ${tokenizer === undefined ? 'missing' : 'available'}; creating WhisperTextStreamer.`,
    );
    const streamer = new WhisperTextStreamer((pipeline as any).tokenizer, {
      skip_prompt: true,
      callback_function: (text) => {
        const fragmentText = text.trim();
        debug?.(
          `[transcription] streamer text callback length=${text.length}; trimmed=${fragmentText.length}.`,
        );

        if (fragmentText.length === 0) {
          return;
        }

        pendingStreamedText = [pendingStreamedText, fragmentText]
          .filter(Boolean)
          .join(' ');

        const sentences = this.#extractCompletedSentences(pendingStreamedText);
        pendingStreamedText = sentences.remainingText;

        if (sentences.completedSentences.length === 0) {
          return;
        }

        streamedFragments.push(
          ...sentences.completedSentences.map((sentence) => ({
            timestampInMs: Math.round(currentChunkStartSeconds * 1000),
            text: sentence,
          })),
        );
        emittedLiveTranscript = true;
        fragmentCallback(streamedFragments);
      },
      on_chunk_start: (time) => {
        const chunkBaseSeconds =
          audioChunkIndex * TRANSCRIPTION_CHUNK_ADVANCE_SECONDS;
        currentChunkStartSeconds = chunkBaseSeconds + time;
        debug?.(
          `[transcription] streamer segment start local=${time.toFixed(2)}s; absolute=${currentChunkStartSeconds.toFixed(2)}s (audio chunk #${audioChunkIndex}).`,
        );
      },
      on_chunk_end: (time) => {
        debug?.(
          `[transcription] streamer segment end local=${time.toFixed(2)}s.`,
        );
      },
      on_finalize: () => {
        const finalText = pendingStreamedText.trim();

        if (finalText.length > 0) {
          streamedFragments.push({
            timestampInMs: Math.round(currentChunkStartSeconds * 1000),
            text: finalText,
          });
          emittedLiveTranscript = true;
          fragmentCallback(streamedFragments);
          pendingStreamedText = '';
        }

        audioChunkIndex += 1;
        debug?.(
          `[transcription] audio chunk finalized; advancing to chunk #${audioChunkIndex}.`,
        );
      },
    });
    const result = (await this.#withAudioInput(
      meetingAudio,
      (audioInput) => {
        debug?.(
          `[transcription] invoking pipeline with ${this.#describeAudioInput(audioInput)}...`,
        );

        return pipeline(audioInput, {
          chunk_length_s: TRANSCRIPTION_CHUNK_SECONDS,
          stride_length_s: TRANSCRIPTION_STRIDE_SECONDS,
          return_timestamps: true,
          streamer,
          ...(language !== undefined ? { language } : {}),
          ...(task !== undefined ? { task } : {}),
        });
      },
      debug,
    )) as TranscriptionResult;
    debug?.(
      `[transcription] pipeline resolved with ${this.#describeTranscriptionResult(result)}; emittedLiveTranscript=${emittedLiveTranscript}.`,
    );

    if (typeof result === 'string') {
      if (!emittedLiveTranscript) {
        debug?.(
          '[transcription] no streamed fragments; emitting string result fallback.',
        );
        fragmentCallback([{ timestampInMs: 0, text: result }]);
      }

      return result;
    }

    const text = result.text ?? '';
    const fragments = this.#extractTranscriptFragments(result);
    debug?.(
      `[transcription] emitting ${fragments.length} timestamped result chunk(s).`,
    );

    fragmentCallback(
      fragments.length > 0 ? fragments : [{ timestampInMs: 0, text }],
    );

    return text;
  }

  /**
   * Outputs an array with speaker turns for a given audio file.
   */
  async diarizeAudio(
    meetingAudio: MeetingAudio,
    options: DiarizationOptions = {},
  ): Promise<SpeakerTurn[]> {
    const speakerCountHint = this.#normalizeSpeakerCountHint(
      options.speakerCountHint,
    );

    if (speakerCountHint !== null) {
      options.debug?.(
        `[diarization] constraining output to ${speakerCountHint} speaker(s).`,
      );
    }

    const activeModel = await this.#requireActiveModel('diarization');
    const modelId = `${activeModel.manifest.model}/${activeModel.manifest.version}`;
    const processor = (await AutoProcessor.from_pretrained(modelId)) as any;
    const model = (await AutoModelForAudioFrameClassification.from_pretrained(
      modelId,
      {
        device:
          typeof (globalThis as { navigator?: { gpu?: unknown } }).navigator
            ?.gpu !== 'undefined'
            ? 'webgpu'
            : 'wasm',
        dtype: activeModel.manifest.quantization as any,
      },
    )) as any;
    const sampleRate =
      processor.feature_extractor?.config.sampling_rate ?? 16_000;
    const readAudio = read_audio as unknown as (
      input: unknown,
      sampleRate: number,
    ) => Promise<Float32Array>;
    const rawAudio = await this.#withAudioInput(meetingAudio, (audioInput) =>
      audioInput instanceof Float32Array
        ? Promise.resolve(audioInput)
        : readAudio(audioInput, sampleRate),
    );
    const audio = this.#sanitizeAudioSamples(rawAudio);

    if (audio.length === 0) {
      return [];
    }

    const chunkSize = Math.max(
      1,
      Math.floor(DIARIZATION_CHUNK_SECONDS * sampleRate),
    );
    const overlapSize = Math.min(
      chunkSize - 1,
      Math.floor(DIARIZATION_OVERLAP_SECONDS * sampleRate),
    );
    const stepSize = chunkSize - overlapSize;
    const stitchingState: DiarizationStitchingState = {
      speakerIndex: 0,
      turns: [],
    };

    options.debug?.(
      `[diarization] processing ${(audio.length / sampleRate).toFixed(2)}s audio in ${DIARIZATION_CHUNK_SECONDS}s chunk(s).`,
    );

    for (
      let startSample = 0;
      startSample < audio.length;
      startSample += stepSize
    ) {
      const endSample = Math.min(audio.length, startSample + chunkSize);
      const chunkTurns = await this.#diarizeAudioChunkSafely(
        audio,
        startSample,
        endSample,
        audio.length,
        sampleRate,
        processor,
        model,
        speakerCountHint,
        options.debug,
      );

      this.#appendDiarizationChunkTurns(
        stitchingState,
        chunkTurns,
        startSample,
        endSample,
        audio.length,
        sampleRate,
      );

      if (endSample === audio.length) {
        break;
      }
    }

    return this.#smoothSpeakerTurns(
      this.#mergeSpeakerTurns(stitchingState.turns),
    );
  }

  async #diarizeAudioChunkSafely(
    audio: Float32Array,
    startSample: number,
    endSample: number,
    totalSamples: number,
    sampleRate: number,
    processor: any,
    model: any,
    speakerCountHint: number | null,
    debug?: (line: string) => void,
  ): Promise<SpeakerTurn[]> {
    try {
      return await this.#diarizeAudioChunk(
        audio.subarray(startSample, endSample),
        startSample,
        sampleRate,
        processor,
        model,
        speakerCountHint,
      );
    } catch (error) {
      const chunkSamples = endSample - startSample;
      const minChunkSamples = Math.max(
        1,
        Math.floor(DIARIZATION_MIN_CHUNK_SECONDS * sampleRate),
      );
      const message = this.#getErrorMessage(error);

      if (chunkSamples <= minChunkSamples) {
        debug?.(
          `[diarization] skipping ${(chunkSamples / sampleRate).toFixed(2)}s chunk after ONNX Runtime failure: ${message}`,
        );
        return [];
      }

      const midpoint = startSample + Math.floor(chunkSamples / 2);
      debug?.(
        `[diarization] splitting ${(chunkSamples / sampleRate).toFixed(2)}s chunk after ONNX Runtime failure: ${message}`,
      );

      const firstHalf = await this.#diarizeAudioChunkSafely(
        audio,
        startSample,
        midpoint,
        totalSamples,
        sampleRate,
        processor,
        model,
        speakerCountHint,
        debug,
      );
      const secondHalf = await this.#diarizeAudioChunkSafely(
        audio,
        midpoint,
        endSample,
        totalSamples,
        sampleRate,
        processor,
        model,
        speakerCountHint,
        debug,
      );

      return [...firstHalf, ...secondHalf];
    }
  }

  async #diarizeAudioChunk(
    chunk: Float32Array,
    chunkStartSample: number,
    sampleRate: number,
    processor: any,
    model: any,
    speakerCountHint: number | null,
  ): Promise<SpeakerTurn[]> {
    const inputs = await processor(chunk);
    const { logits } = await model(inputs);
    const result =
      speakerCountHint === null
        ? (processor.post_process_speaker_diarization(
            logits,
            chunk.length,
          ) as any[])
        : this.#postProcessSpeakerDiarizationWithSpeakerCount(
            logits,
            chunk.length,
            processor,
            speakerCountHint,
          );
    const chunkStartSeconds = chunkStartSample / sampleRate;

    const segments = (result[0] ?? []) as Array<{
      id: string | number;
      start: number;
      end: number;
    }>;

    return segments
      .map((segment): SpeakerTurn | null => {
        const startSeconds = chunkStartSeconds + segment.start;
        const endSeconds = chunkStartSeconds + segment.end;

        if (endSeconds <= startSeconds) {
          return null;
        }

        return {
          speaker: `SPEAKER_${String(segment.id).padStart(2, '0')}`,
          startSeconds,
          endSeconds,
          text: '',
        };
      })
      .filter((turn): turn is SpeakerTurn => turn !== null);
  }

  #appendDiarizationChunkTurns(
    state: DiarizationStitchingState,
    chunkTurns: SpeakerTurn[],
    startSample: number,
    endSample: number,
    totalSamples: number,
    sampleRate: number,
  ): void {
    const chunkStartSeconds = startSample / sampleRate;
    const chunkEndSeconds = endSample / sampleRate;
    const trimStartSeconds =
      startSample === 0
        ? chunkStartSeconds
        : chunkStartSeconds + DIARIZATION_OVERLAP_SECONDS / 2;
    const trimEndSeconds =
      endSample >= totalSamples
        ? chunkEndSeconds
        : chunkEndSeconds - DIARIZATION_OVERLAP_SECONDS / 2;
    const speakerMap = this.#mapChunkSpeakersToGlobalSpeakers(
      chunkTurns,
      state.turns,
    );

    for (const turn of chunkTurns) {
      let speaker = speakerMap.get(turn.speaker);

      if (speaker === undefined) {
        speaker = `SPEAKER_${String(state.speakerIndex).padStart(2, '0')}`;
        state.speakerIndex += 1;
        speakerMap.set(turn.speaker, speaker);
      }

      const startSeconds = Math.max(trimStartSeconds, turn.startSeconds);
      const endSeconds = Math.min(trimEndSeconds, turn.endSeconds);

      if (endSeconds <= startSeconds) {
        continue;
      }

      state.turns.push({
        ...turn,
        speaker,
        startSeconds,
        endSeconds,
      });
    }
  }

  #mapChunkSpeakersToGlobalSpeakers(
    chunkTurns: SpeakerTurn[],
    previousTurns: SpeakerTurn[],
  ): Map<string, string> {
    const overlapBySpeakerPair = new Map<string, Map<string, number>>();
    const claimedSpeakers = new Set<string>();

    for (const chunkTurn of chunkTurns) {
      for (const previousTurn of previousTurns) {
        const overlapSeconds = Math.max(
          0,
          Math.min(chunkTurn.endSeconds, previousTurn.endSeconds) -
            Math.max(chunkTurn.startSeconds, previousTurn.startSeconds),
        );

        if (overlapSeconds <= 0) {
          continue;
        }

        const overlapsForChunkSpeaker =
          overlapBySpeakerPair.get(chunkTurn.speaker) ??
          new Map<string, number>();

        overlapsForChunkSpeaker.set(
          previousTurn.speaker,
          (overlapsForChunkSpeaker.get(previousTurn.speaker) ?? 0) +
            overlapSeconds,
        );
        overlapBySpeakerPair.set(chunkTurn.speaker, overlapsForChunkSpeaker);
      }
    }

    const sortedMatches = [...overlapBySpeakerPair.entries()]
      .flatMap(([chunkSpeaker, overlaps]) =>
        [...overlaps.entries()].map(([speaker, overlapSeconds]) => ({
          chunkSpeaker,
          speaker,
          overlapSeconds,
        })),
      )
      .sort((first, second) => second.overlapSeconds - first.overlapSeconds);
    const speakerMap = new Map<string, string>();

    for (const match of sortedMatches) {
      if (
        speakerMap.has(match.chunkSpeaker) ||
        claimedSpeakers.has(match.speaker)
      ) {
        continue;
      }

      speakerMap.set(match.chunkSpeaker, match.speaker);
      claimedSpeakers.add(match.speaker);
    }

    return speakerMap;
  }

  #mergeSpeakerTurns(turns: SpeakerTurn[]): SpeakerTurn[] {
    const sortedTurns = [...turns].sort(
      (first, second) => first.startSeconds - second.startSeconds,
    );
    const mergedTurns: SpeakerTurn[] = [];

    for (const turn of sortedTurns) {
      const previousTurn = mergedTurns.at(-1);

      if (previousTurn !== undefined && previousTurn.speaker === turn.speaker) {
        previousTurn.endSeconds = Math.max(
          previousTurn.endSeconds,
          turn.endSeconds,
        );
        continue;
      }

      mergedTurns.push({ ...turn });
    }

    return mergedTurns;
  }

  #smoothSpeakerTurns(turns: SpeakerTurn[]): SpeakerTurn[] {
    const sortedTurns = [...turns].sort(
      (first, second) => first.startSeconds - second.startSeconds,
    );
    const smoothedTurns: SpeakerTurn[] = [];

    for (let index = 0; index < sortedTurns.length; index += 1) {
      const turn = sortedTurns[index];
      const previousTurn = smoothedTurns.at(-1);
      const nextTurn = sortedTurns[index + 1];
      const durationSeconds = turn.endSeconds - turn.startSeconds;

      if (
        durationSeconds < DIARIZATION_MIN_TURN_SECONDS &&
        previousTurn !== undefined &&
        nextTurn !== undefined &&
        previousTurn.speaker === nextTurn.speaker &&
        turn.startSeconds - previousTurn.endSeconds <=
          DIARIZATION_SMOOTHING_GAP_SECONDS &&
        nextTurn.startSeconds - turn.endSeconds <=
          DIARIZATION_SMOOTHING_GAP_SECONDS
      ) {
        previousTurn.endSeconds = Math.max(
          previousTurn.endSeconds,
          nextTurn.endSeconds,
        );
        index += 1;
        continue;
      }

      if (
        durationSeconds < DIARIZATION_MIN_TURN_SECONDS &&
        previousTurn !== undefined &&
        turn.startSeconds - previousTurn.endSeconds <=
          DIARIZATION_SMOOTHING_GAP_SECONDS
      ) {
        previousTurn.endSeconds = Math.max(
          previousTurn.endSeconds,
          turn.endSeconds,
        );
        continue;
      }

      smoothedTurns.push({ ...turn });
    }

    return this.#mergeSpeakerTurns(smoothedTurns);
  }

  #sanitizeAudioSamples(audio: Float32Array): Float32Array {
    let needsCopy = false;

    for (let index = 0; index < audio.length; index += 1) {
      const sample = audio[index];

      if (!Number.isFinite(sample) || sample < -1 || sample > 1) {
        needsCopy = true;
        break;
      }
    }

    if (!needsCopy) {
      return audio;
    }

    const sanitized = new Float32Array(audio.length);

    for (let index = 0; index < audio.length; index += 1) {
      const sample = audio[index];

      sanitized[index] = Number.isFinite(sample)
        ? Math.max(-1, Math.min(1, sample))
        : 0;
    }

    return sanitized;
  }

  #resampleAudioIfNeeded(
    audio: Float32Array,
    sourceSampleRate: number | undefined,
    targetSampleRate: number,
  ): Float32Array {
    if (
      sourceSampleRate === undefined ||
      !Number.isFinite(sourceSampleRate) ||
      sourceSampleRate <= 0 ||
      Math.round(sourceSampleRate) === Math.round(targetSampleRate)
    ) {
      return audio;
    }

    const targetLength = Math.max(
      1,
      Math.round((audio.length * targetSampleRate) / sourceSampleRate),
    );
    const resampled = new Float32Array(targetLength);
    const ratio = sourceSampleRate / targetSampleRate;

    for (let index = 0; index < targetLength; index += 1) {
      const sourceIndex = index * ratio;
      const lowerIndex = Math.floor(sourceIndex);
      const upperIndex = Math.min(audio.length - 1, lowerIndex + 1);
      const weight = sourceIndex - lowerIndex;
      const lowerSample = audio[lowerIndex] ?? 0;
      const upperSample = audio[upperIndex] ?? lowerSample;

      resampled[index] = lowerSample + (upperSample - lowerSample) * weight;
    }

    return resampled;
  }

  #normalizeSpeakerCountHint(value: number | null | undefined): number | null {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return null;
    }

    return Math.max(1, Math.floor(value));
  }

  #postProcessSpeakerDiarizationWithSpeakerCount(
    logits: { tolist(): number[][][] },
    numSamples: number,
    processor: any,
    speakerCount: number,
  ): any[] {
    const featureExtractor = processor.feature_extractor ?? processor;
    const config = featureExtractor.config ?? {};
    const samplingRate = config.sampling_rate ?? 16_000;
    const frameCount =
      typeof featureExtractor.samples_to_frames === 'function'
        ? featureExtractor.samples_to_frames(numSamples)
        : numSamples;
    const ratio = numSamples / frameCount / samplingRate;

    return logits.tolist().map((scores) => {
      const segments: Array<{
        id: number;
        start: number;
        end: number;
        score: number;
      }> = [];
      let currentSpeaker = -1;

      for (let index = 0; index < scores.length; index += 1) {
        const frameScores = scores[index];
        const limitedCount = Math.min(speakerCount, frameScores.length);
        let id = 0;
        let score = frameScores[0] ?? 0;

        for (
          let speakerIndex = 1;
          speakerIndex < limitedCount;
          speakerIndex += 1
        ) {
          const speakerScore =
            frameScores[speakerIndex] ?? Number.NEGATIVE_INFINITY;

          if (speakerScore > score) {
            id = speakerIndex;
            score = speakerScore;
          }
        }

        if (id !== currentSpeaker) {
          currentSpeaker = id;
          segments.push({ id, start: index, end: index + 1, score });
        } else {
          const segment = segments.at(-1);

          if (segment !== undefined) {
            segment.end = index + 1;
            segment.score += score;
          }
        }
      }

      return segments.map(({ id, start, end, score }) => ({
        id,
        start: start * ratio,
        end: end * ratio,
        confidence: score / (end - start),
      }));
    });
  }

  /**
   * Aligns a given transcript to audio, each word will get a start time.
   * Punctuation will be attached to the previous word.
   */
  async alignTranscriptToAudio(
    transcript: string,
    meetingAudio: MeetingAudio,
    debug?: (line: string) => void,
    inputSampleRate?: number,
  ): Promise<TimestampedWord[]> {
    const activeModel = await this.#requireActiveModel('text-audio-sync');
    const transcriptWords = transcript.match(/\S+/g) ?? [];

    if (transcriptWords.length === 0) {
      return [];
    }

    const modelId = `${activeModel.manifest.model}/${activeModel.manifest.version}`;
    const loadOptions = {
      local_files_only: true,
    };
    const processor = (await AutoProcessor.from_pretrained(
      modelId,
      loadOptions,
    )) as any;
    const tokenizer = (processor.tokenizer ??
      (await AutoTokenizer.from_pretrained(
        modelId,
        loadOptions,
      ))) as CtcTokenizer;
    const model = (await AutoModelForCTC.from_pretrained(modelId, {
      ...loadOptions,
      device:
        typeof (globalThis as { navigator?: { gpu?: unknown } }).navigator
          ?.gpu !== 'undefined'
          ? 'webgpu'
          : 'wasm',
      dtype: activeModel.manifest.quantization as any,
    })) as any;
    const sampleRate =
      processor.feature_extractor?.config.sampling_rate ?? 16_000;
    debug?.(
      `[alignment] model sampleRate=${sampleRate}; inputSampleRate=${inputSampleRate ?? 'unknown'}.`,
    );
    const readAudio = read_audio as unknown as (
      input: unknown,
      sampleRate: number,
    ) => Promise<Float32Array>;
    const rawAudio = await this.#withAudioInput(meetingAudio, (audioInput) =>
      audioInput instanceof Float32Array
        ? Promise.resolve(
            this.#resampleAudioIfNeeded(
              audioInput,
              inputSampleRate,
              sampleRate,
            ),
          )
        : readAudio(audioInput, sampleRate),
    );
    const audio = this.#sanitizeAudioSamples(rawAudio);

    if (audio.length === 0) {
      return [];
    }

    debug?.(
      `[alignment] audio frames=${audio.length}; duration=${(audio.length / sampleRate).toFixed(3)}s.`,
    );

    const chunkSize = Math.max(
      1,
      Math.floor(ALIGNMENT_CHUNK_SECONDS * sampleRate),
    );
    const ctcWords: CtcWord[] = [];

    debug?.(
      `[alignment] processing ${(audio.length / sampleRate).toFixed(2)}s audio in ${ALIGNMENT_CHUNK_SECONDS}s chunk(s).`,
    );

    for (
      let startSample = 0;
      startSample < audio.length;
      startSample += chunkSize
    ) {
      const endSample = Math.min(audio.length, startSample + chunkSize);
      const chunk = audio.subarray(startSample, endSample);

      try {
        const inputs = await processor(chunk);
        const output = await model(inputs);
        const logits = output.logits as TensorLike | undefined;

        if (logits === undefined || logits.dims.length < 3) {
          continue;
        }

        const chunkOffsetSeconds = startSample / sampleRate;
        const chunkWords = this.#extractCtcWords(
          logits,
          tokenizer,
          chunk.length / sampleRate,
        );

        ctcWords.push(
          ...chunkWords.map((word) => ({
            ...word,
            startSeconds: word.startSeconds + chunkOffsetSeconds,
          })),
        );
      } catch (error) {
        debug?.(
          `[alignment] skipping ${(chunk.length / sampleRate).toFixed(2)}s chunk at ${(startSample / sampleRate).toFixed(2)}s after ONNX Runtime failure: ${this.#getErrorMessage(error)}`,
        );
      }
    }

    return this.#mapTranscriptWordsToCtcWords(transcriptWords, ctcWords);
  }

  async #getPipelineForActiveModel(
    model: ManagedModel,
    additionalOptions?: Omit<
      Parameters<typeof this.pipelineFactory.getPipeline>[1],
      never
    >,
  ): Promise<CallablePipeline> {
    const activeModel = await this.#requireActiveModel(model);

    return (await this.pipelineFactory.getPipeline(
      activeModel.manifest,
      additionalOptions,
    )) as CallablePipeline;
  }

  async #requireActiveModel(model: ManagedModel) {
    const activeModel = await this.modelManager.getActiveVersion(model);

    if (activeModel === null) {
      throw new Error(`Download and activate a ${model} model first.`);
    }

    return activeModel;
  }

  async #withAudioInput<T>(
    meetingAudio: MeetingAudio,
    callback: (audioInput: AudioInput) => Promise<T>,
    debug?: (line: string) => void,
  ): Promise<T> {
    debug?.('[audio] converting MeetingAudio to AudioInput...');
    const audioInput = await this.#toAudioInput(meetingAudio);
    debug?.(`[audio] converted to ${this.#describeAudioInput(audioInput)}.`);

    try {
      return await callback(audioInput);
    } finally {
      if (typeof audioInput === 'string' && audioInput.startsWith('blob:')) {
        debug?.('[audio] revoking temporary blob URL.');
        URL.revokeObjectURL(audioInput);
      }
    }
  }

  async #toAudioInput(meetingAudio: MeetingAudio): Promise<AudioInput> {
    if (meetingAudio instanceof Float32Array) {
      return meetingAudio;
    }

    if (typeof URL.createObjectURL === 'function') {
      if (meetingAudio instanceof Blob) {
        return URL.createObjectURL(meetingAudio);
      }

      if (meetingAudio instanceof ArrayBuffer) {
        return URL.createObjectURL(new Blob([meetingAudio]));
      }

      if (meetingAudio instanceof Uint8Array) {
        return URL.createObjectURL(new Blob([new Uint8Array(meetingAudio)]));
      }
    }

    return this.#toFloat32Samples(meetingAudio);
  }

  #describeMeetingAudio(meetingAudio: MeetingAudio): string {
    if (meetingAudio instanceof Float32Array) {
      return `Float32Array(${meetingAudio.length} samples)`;
    }

    if (meetingAudio instanceof Uint8Array) {
      return `Uint8Array(${meetingAudio.byteLength} bytes)`;
    }

    if (meetingAudio instanceof ArrayBuffer) {
      return `ArrayBuffer(${meetingAudio.byteLength} bytes)`;
    }

    if (meetingAudio instanceof Blob) {
      return `Blob(${meetingAudio.size} bytes, ${meetingAudio.type || 'unknown type'})`;
    }

    return 'unknown audio input';
  }

  #describeAudioInput(audioInput: AudioInput): string {
    if (audioInput instanceof Float32Array) {
      return `Float32Array(${audioInput.length} samples)`;
    }

    if (audioInput instanceof Float64Array) {
      return `Float64Array(${audioInput.length} samples)`;
    }

    if (audioInput instanceof URL) {
      return `URL(${audioInput.href})`;
    }

    return audioInput.startsWith('blob:')
      ? 'blob URL'
      : `string(${audioInput})`;
  }

  #describeTranscriptionResult(result: TranscriptionResult): string {
    if (typeof result === 'string') {
      return `string(length=${result.length})`;
    }

    return `object(textLength=${result.text?.length ?? 0}, chunks=${result.chunks?.length ?? 0})`;
  }

  #extractCompletedSentences(text: string): {
    completedSentences: string[];
    remainingText: string;
  } {
    const completedSentences: string[] = [];
    const sentencePattern = /[^.!?]+[.!?]+(?:["')\]]+)?/g;
    let match: RegExpExecArray | null;
    let consumedLength = 0;

    while ((match = sentencePattern.exec(text)) !== null) {
      const sentence = match[0].trim();

      if (sentence.length === 0) {
        continue;
      }

      completedSentences.push(sentence);
      consumedLength = sentencePattern.lastIndex;
    }

    return {
      completedSentences,
      remainingText: text.slice(consumedLength).trim(),
    };
  }

  #buildSegments(
    transcript: string,
    fragments: TimestampedText[],
    alignedWords: TimestampedWord[],
    speakerTurns: SpeakerTurn[],
  ): Omit<TranscriptSegment, 'speakerName'>[] {
    const sourceFragments =
      fragments.length > 0
        ? fragments
        : this.#buildFragmentsFromAlignedWords(transcript, alignedWords);

    return sourceFragments.map((fragment, index) => {
      const nextFragment = sourceFragments[index + 1];
      const startSeconds = fragment.timestampInMs / 1000;
      const endSeconds =
        nextFragment?.timestampInMs !== undefined
          ? nextFragment.timestampInMs / 1000
          : this.#estimateFragmentEndSeconds(startSeconds, fragment.text);
      const speaker = this.#findSpeakerForRange(
        startSeconds,
        endSeconds,
        speakerTurns,
      );

      return {
        text: fragment.text,
        startSeconds,
        endSeconds,
        speaker,
      };
    });
  }

  #estimateFragmentEndSeconds(startSeconds: number, text: string): number {
    const wordCount = text.split(/\s+/).filter(Boolean).length;

    return startSeconds + Math.max(1, wordCount * 0.45);
  }

  async #toFloat32Samples(meetingAudio: MeetingAudio): Promise<Float32Array> {
    if (meetingAudio instanceof Float32Array) {
      return meetingAudio;
    }

    if (meetingAudio instanceof ArrayBuffer) {
      return this.#bufferToFloat32Array(meetingAudio);
    }

    if (meetingAudio instanceof Uint8Array) {
      return this.#bufferToFloat32Array(
        meetingAudio.buffer.slice(
          meetingAudio.byteOffset,
          meetingAudio.byteOffset + meetingAudio.byteLength,
        ),
      );
    }

    if (meetingAudio instanceof Blob) {
      return this.#bufferToFloat32Array(await meetingAudio.arrayBuffer());
    }

    return new Float32Array(0);
  }

  #bufferToFloat32Array(buffer: ArrayBufferLike): Float32Array {
    if (buffer.byteLength === 0) {
      return new Float32Array(0);
    }

    if (buffer.byteLength % Float32Array.BYTES_PER_ELEMENT === 0) {
      return new Float32Array(buffer);
    }

    const bytes = new Uint8Array(buffer);
    const samples = new Float32Array(bytes.length);

    for (let index = 0; index < bytes.length; index += 1) {
      samples[index] = (bytes[index] - 128) / 128;
    }

    return samples;
  }

  #buildFragmentsFromAlignedWords(
    transcript: string,
    alignedWords: TimestampedWord[],
  ): TimestampedText[] {
    if (alignedWords.length === 0) {
      return [{ timestampInMs: 0, text: transcript }];
    }

    return alignedWords.map((word) => ({
      timestampInMs: word.timestampInMs,
      text: word.word,
    }));
  }

  #findSpeakerForRange(
    startSeconds: number,
    endSeconds: number,
    speakerTurns: SpeakerTurn[],
  ): string {
    let bestTurn: SpeakerTurn | undefined;
    let bestOverlap = 0;

    for (const turn of speakerTurns) {
      const overlap = Math.max(
        0,
        Math.min(endSeconds, turn.endSeconds) -
          Math.max(startSeconds, turn.startSeconds),
      );

      if (overlap > bestOverlap) {
        bestTurn = turn;
        bestOverlap = overlap;
      }
    }

    return bestTurn?.speaker ?? 'SPEAKER_0';
  }

  async nameSpeakers(
    meeting: Meeting,
    segments: Omit<TranscriptSegment, 'speakerName'>[],
  ): Promise<Map<string, string>> {
    const speakers = [...new Set(segments.map((segment) => segment.speaker))];

    if (speakers.length === 0) {
      return new Map();
    }

    const activeModel = await this.#requireActiveModel('language');

    try {
      const pipeline = (await this.pipelineFactory.getPipeline(
        activeModel.manifest,
      )) as CallablePipeline;
      const parsed = new Map<string, string>();
      const chunkStep =
        SPEAKER_NAMING_SEGMENT_CHUNK_SIZE -
        SPEAKER_NAMING_SEGMENT_CHUNK_OVERLAP;

      for (
        let startIndex = 0;
        startIndex < segments.length;
        startIndex += chunkStep
      ) {
        const remainingSpeakers = speakers.filter(
          (speaker) => !parsed.has(speaker),
        );

        if (remainingSpeakers.length === 0) {
          break;
        }

        const chunk = segments.slice(
          startIndex,
          startIndex + SPEAKER_NAMING_SEGMENT_CHUNK_SIZE,
        );
        const chunkSpeakers = remainingSpeakers.filter((speaker) =>
          chunk.some((segment) => segment.speaker === speaker),
        );

        if (chunkSpeakers.length === 0) {
          continue;
        }

        const result = (await pipeline(
          this.#createSpeakerNamingPrompt(
            meeting,
            chunk,
            chunkSpeakers,
            parsed,
          ),
          {
            max_new_tokens: 256,
            return_full_text: false,
          },
        )) as TextGenerationResult;
        const text = this.#getGeneratedText(result);
        const chunkParsed = this.#parseSpeakerNames(text);
        for (const [speaker, name] of chunkParsed) {
          if (!parsed.has(speaker)) {
            parsed.set(speaker, name);
          }
        }
      }

      return new Map(
        speakers.map((speaker) => [speaker, parsed.get(speaker) ?? speaker]),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'Not supported in pipelines' ||
          this.#isModelSessionError(error))
      ) {
        return new Map(speakers.map((speaker) => [speaker, speaker]));
      }

      throw error;
    }
  }

  #isModelSessionError(error: unknown): boolean {
    const message = this.#getErrorMessage(error);

    return (
      message.includes("Can't create a session") ||
      message.includes('Failed to load external data file') ||
      message.includes('Deserialize tensor')
    );
  }

  #getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === 'string') {
      return error;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  #createSpeakerNamingPrompt(
    meeting: Meeting,
    segments: Omit<TranscriptSegment, 'speakerName'>[],
    speakers: string[],
    knownSpeakerNames: Map<string, string>,
  ): string {
    return [
      'Infer human names for transcript speaker labels when the name is explicit.',
      'Return only JSON in this shape: [{"speaker":"SPEAKER_0","name":"Alice"}].',
      'If a name is not available, leave it out of the response',
      `Meeting title: ${meeting.title ?? 'Untitled meeting'}`,
      `Speakers: ${speakers.join(', ')}`,
      'Segments:',
      ...segments.map(
        (segment) =>
          `${knownSpeakerNames.get(segment.speaker) ?? segment.speaker}: ${segment.text}`,
      ),
    ].join('\n');
  }

  #getGeneratedText(result: TextGenerationResult): string {
    if (typeof result === 'string') {
      return result;
    }

    if (Array.isArray(result)) {
      return result[0]?.generated_text ?? '';
    }

    return result.generated_text ?? '';
  }

  #extractTranscriptFragments(value: unknown): TimestampedText[] {
    if (typeof value !== 'object' || value === null) {
      return [];
    }

    const record = value as Record<string, unknown>;

    if (Array.isArray(record.chunks)) {
      return record.chunks
        .map((chunk) => this.#toTranscriptFragment(chunk))
        .filter((fragment): fragment is TimestampedText => fragment !== null);
    }

    const fragment = this.#toTranscriptFragment(value);

    return fragment === null ? [] : [fragment];
  }

  #toTranscriptFragment(value: unknown): TimestampedText | null {
    if (typeof value !== 'object' || value === null) {
      return null;
    }

    const record = value as Record<string, unknown>;
    const text = typeof record.text === 'string' ? record.text.trim() : '';

    if (text.length === 0) {
      return null;
    }

    const timestamp = record.timestamp;

    if (Array.isArray(timestamp)) {
      const start = timestamp[0];

      if (typeof start === 'number') {
        return { timestampInMs: Math.round(start * 1000), text };
      }
    }

    if (typeof record.start === 'number') {
      return { timestampInMs: Math.round(record.start * 1000), text };
    }

    if (typeof record.timestampInMs === 'number') {
      return { timestampInMs: record.timestampInMs, text };
    }

    return null;
  }

  #parseSpeakerNames(text: string): Map<string, string> {
    const json =
      text.match(/\[[\s\S]*\]/)?.[0] ?? text.match(/\{[\s\S]*\}/)?.[0];

    if (json === undefined) {
      return new Map();
    }

    try {
      const parsed = JSON.parse(json) as unknown;
      const guesses = Array.isArray(parsed) ? parsed : [parsed];
      const names = new Map<string, string>();

      for (const guess of guesses) {
        if (!this.#isSpeakerNameGuess(guess)) {
          continue;
        }

        if (
          guess.name !== null &&
          guess.name !== undefined &&
          guess.name.trim().length > 0
        ) {
          names.set(guess.speaker, guess.name.trim());
        }
      }

      return names;
    } catch {
      return new Map();
    }
  }

  #extractCtcWords(
    logits: TensorLike,
    tokenizer: CtcTokenizer,
    durationSeconds: number,
  ): CtcWord[] {
    const [, frameCount = 0, vocabularySize = 0] = logits.dims;

    if (frameCount === 0 || vocabularySize === 0) {
      return [];
    }

    const vocabulary = tokenizer.get_vocab();
    const tokensById = new Map<number, string>(
      [...vocabulary.entries()].map(([token, id]) => [id, token]),
    );
    const blankId = tokenizer.pad_token_id ?? vocabulary.get('<pad>') ?? 0;
    const specialIds = new Set(tokenizer.all_special_ids ?? [blankId]);
    const wordDelimiterToken = tokenizer.word_delimiter_token ?? '|';
    const frameDurationSeconds = durationSeconds / frameCount;
    const words: CtcWord[] = [];
    let currentWord = '';
    let currentWordStartSeconds = 0;
    let previousTokenId = -1;

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const tokenId = this.#argmax(
        logits.data,
        frameIndex * vocabularySize,
        vocabularySize,
      );

      if (tokenId === previousTokenId) {
        continue;
      }

      previousTokenId = tokenId;

      if (tokenId === blankId || specialIds.has(tokenId)) {
        continue;
      }

      const token = tokensById.get(tokenId);

      if (token === undefined) {
        continue;
      }

      if (token === wordDelimiterToken || token.trim().length === 0) {
        if (currentWord.length > 0) {
          words.push({
            text: currentWord,
            startSeconds: currentWordStartSeconds,
          });
          currentWord = '';
        }

        continue;
      }

      if (currentWord.length === 0) {
        currentWordStartSeconds = frameIndex * frameDurationSeconds;
      }

      currentWord += this.#normalizeCtcToken(token);
    }

    if (currentWord.length > 0) {
      words.push({ text: currentWord, startSeconds: currentWordStartSeconds });
    }

    return words;
  }

  #argmax(values: ArrayLike<number>, offset: number, length: number): number {
    let bestIndex = 0;
    let bestValue = values[offset] ?? Number.NEGATIVE_INFINITY;

    for (let index = 1; index < length; index += 1) {
      const value = values[offset + index] ?? Number.NEGATIVE_INFINITY;

      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    }

    return bestIndex;
  }

  #normalizeCtcToken(token: string): string {
    return token.replace(/^##/, '').replace(/^▁/, '');
  }

  #mapTranscriptWordsToCtcWords(
    transcriptWords: string[],
    ctcWords: CtcWord[],
  ): TimestampedWord[] {
    if (ctcWords.length === 0) {
      return [];
    }

    const normalizedCtcWords = ctcWords.map((word) =>
      this.#normalizeAlignmentWord(word.text),
    );
    let ctcIndex = 0;

    return transcriptWords.map((word, wordIndex) => {
      const normalizedWord = this.#normalizeAlignmentWord(word);
      const matchedIndex = this.#findAlignedCtcWordIndex(
        normalizedWord,
        normalizedCtcWords,
        ctcIndex,
      );

      if (matchedIndex !== -1) {
        ctcIndex = matchedIndex + 1;

        return {
          word,
          timestampInMs: Math.round(ctcWords[matchedIndex].startSeconds * 1000),
        };
      }

      const fallbackIndex = Math.min(ctcIndex, ctcWords.length - 1);
      const fallbackTimestamp = ctcWords[fallbackIndex].startSeconds * 1000;
      ctcIndex = Math.min(ctcIndex + 1, ctcWords.length);

      return {
        word,
        timestampInMs: Math.round(
          fallbackTimestamp + Math.max(0, wordIndex - fallbackIndex) * 450,
        ),
      };
    });
  }

  #findAlignedCtcWordIndex(
    word: string,
    ctcWords: string[],
    startIndex: number,
  ): number {
    if (word.length === 0) {
      return startIndex < ctcWords.length ? startIndex : -1;
    }

    const searchEnd = Math.min(ctcWords.length, startIndex + 12);

    for (let index = startIndex; index < searchEnd; index += 1) {
      if (ctcWords[index] === word) {
        return index;
      }
    }

    for (let index = startIndex; index < searchEnd; index += 1) {
      if (this.#areSimilarAlignmentWords(word, ctcWords[index])) {
        return index;
      }
    }

    return -1;
  }

  #normalizeAlignmentWord(word: string): string {
    return word
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{Letter}\p{Number}]+/gu, '')
      .toLowerCase();
  }

  #areSimilarAlignmentWords(first: string, second: string): boolean {
    if (first.length === 0 || second.length === 0) {
      return false;
    }

    if (first.startsWith(second) || second.startsWith(first)) {
      return Math.min(first.length, second.length) >= 3;
    }

    return (
      this.#levenshteinDistance(first, second) <=
      Math.max(1, Math.floor(Math.max(first.length, second.length) * 0.25))
    );
  }

  #levenshteinDistance(first: string, second: string): number {
    const previous = new Array(second.length + 1)
      .fill(0)
      .map((_, index) => index);
    const current = new Array(second.length + 1).fill(0);

    for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
      current[0] = firstIndex;

      for (
        let secondIndex = 1;
        secondIndex <= second.length;
        secondIndex += 1
      ) {
        const substitutionCost =
          first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1;
        current[secondIndex] = Math.min(
          previous[secondIndex] + 1,
          current[secondIndex - 1] + 1,
          previous[secondIndex - 1] + substitutionCost,
        );
      }

      previous.splice(0, previous.length, ...current);
    }

    return previous[second.length];
  }

  #isSpeakerNameGuess(
    value: unknown,
  ): value is { speaker: string; name?: string | null } {
    return (
      typeof value === 'object' &&
      value !== null &&
      'speaker' in value &&
      typeof value.speaker === 'string' &&
      (!('name' in value) ||
        value.name === null ||
        typeof value.name === 'string')
    );
  }
}
