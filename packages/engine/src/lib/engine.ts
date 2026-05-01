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
  AutoModelForAudioFrameClassification,
  AutoProcessor,
  WhisperTextStreamer,
  read_audio,
} from '@huggingface/transformers';

type TimestampedText = { timestampInMs: number; text: string };
type TimestampedWord = { word: string; timestampInMs: number };
type AudioInput = string | URL | Float32Array | Float64Array;
type CallablePipeline = (input: unknown, options?: unknown) => Promise<unknown>;

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
      },
      debug,
    );
    emit?.({ stage: 'transcription', status: 'completed' });

    emit?.({ stage: 'diarization', status: 'started' });
    const speakerTurns = await this.diarizeAudio(meeting.audio);
    const alignedWords = await this.alignTranscriptToAudio(
      transcriptText,
      meeting.audio,
    );
    emit?.({ stage: 'diarization', status: 'completed' });

    const segments = this.#buildSegments(
      transcriptText,
      timestampedFragments,
      alignedWords,
      speakerTurns,
    );

    emit?.({ stage: 'speaker-naming', status: 'started' });
    const speakerNames = await this.#nameSpeakers(
      meeting,
      transcriptText,
      segments,
    );
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
   * Generates a transcript of a given audio file.
   */
  async transcribeAudio(
    meetingAudio: MeetingAudio,
    fragmentCallback: (fragments: TimestampedText[]) => void,
    debug?: (line: string) => void,
  ): Promise<string> {
    debug?.(`[transcription] input ${this.#describeMeetingAudio(meetingAudio)}`);
    debug?.('[transcription] loading Whisper pipeline...');
    const pipeline = await this.#getPipelineForActiveModel('whisper', {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
    }) as AutomaticSpeechRecognitionPipeline;
    debug?.('[transcription] Whisper pipeline ready.');
    const streamedFragments: TimestampedText[] = [];
    let currentChunkStartSeconds = 0;
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

        const fragment = {
          timestampInMs: Math.round(currentChunkStartSeconds * 1000),
          text: fragmentText,
        };

        streamedFragments.push(fragment);
        fragmentCallback([fragment]);
      },
      on_chunk_start: (time) => {
        currentChunkStartSeconds = time;
        debug?.(`[transcription] streamer chunk start ${time.toFixed(2)}s.`);
      },
      on_chunk_end: (time) => {
        debug?.(`[transcription] streamer chunk end ${time.toFixed(2)}s.`);
      },
      on_finalize: () => {
        debug?.('[transcription] streamer finalized.');
      },
    });
    const result = (await this.#withAudioInput(
      meetingAudio,
      (audioInput) => {
        debug?.(
          `[transcription] invoking pipeline with ${this.#describeAudioInput(audioInput)}...`,
        );

        return pipeline(audioInput, {
          streamer,
        });
      },
      debug,
    )) as TranscriptionResult;
    debug?.(
      `[transcription] pipeline resolved with ${this.#describeTranscriptionResult(result)}; streamedFragments=${streamedFragments.length}.`,
    );

    if (typeof result === 'string') {
      if (streamedFragments.length === 0) {
        debug?.('[transcription] no streamed fragments; emitting string result fallback.');
        fragmentCallback([{ timestampInMs: 0, text: result }]);
      }

      return result;
    }

    const text = result.text ?? '';
    if (streamedFragments.length === 0) {
      const fragments = this.#extractTranscriptFragments(result);
      debug?.(
        `[transcription] no streamed fragments; emitting ${fragments.length} result chunk fallback(s).`,
      );

      fragmentCallback(
        fragments.length > 0 ? fragments : [{ timestampInMs: 0, text }],
      );
    }

    return text;
  }

  /**
   * Outputs an array with speaker turns for a given audio file.
   */
  async diarizeAudio(meetingAudio: MeetingAudio): Promise<SpeakerTurn[]> {
    const activeModel = await this.#requireActiveModel('pyannote');
    const modelId = activeModel.manifest.modelName;
    const processor = (await AutoProcessor.from_pretrained(modelId)) as any;
    const model = (await AutoModelForAudioFrameClassification.from_pretrained(
      modelId,
      {
        device: typeof (globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu !== 'undefined'
          ? 'webgpu'
          : 'wasm',
        dtype: 'fp32',
      },
    )) as any;
    const sampleRate = processor.feature_extractor?.config.sampling_rate ?? 16_000;
    const readAudio = read_audio as unknown as (
      input: unknown,
      sampleRate: number,
    ) => Promise<Float32Array>;
    const audio = await this.#withAudioInput(meetingAudio, (audioInput) =>
      audioInput instanceof Float32Array
        ? Promise.resolve(audioInput)
        : readAudio(audioInput, sampleRate),
    );

    if (audio.length === 0) {
      return [];
    }

    const inputs = await processor(audio);
    const { logits } = await model(inputs);
    const result = processor.post_process_speaker_diarization(logits, audio.length) as any[];

    return (result[0] ?? []).map((segment: { id: string | number; start: number; end: number }) => ({
      speaker: `SPEAKER_${String(segment.id).padStart(2, '0')}`,
      startSeconds: segment.start,
      endSeconds: segment.end,
      text: '',
    }));
  }

  /**
   * Aligns a given transcript to audio, each word will get a start time.
   * Punctuation will be attached to the previous word.
   */
  async alignTranscriptToAudio(
    transcript: string,
    meetingAudio: MeetingAudio,
  ): Promise<TimestampedWord[]> {
    const activeModel = await this.#requireActiveModel('wav2vec2');

    try {
      const pipeline = (await this.pipelineFactory.getPipeline(
        activeModel.manifest,
      )) as CallablePipeline;
      const result = (await this.#withAudioInput(meetingAudio, (audioInput) =>
        pipeline(audioInput, { transcript }),
      )) as unknown;

      if (Array.isArray(result)) {
        return result
          .map((item) => this.#toTimestampedWord(item))
          .filter((item): item is TimestampedWord => item !== null);
      }

      return [];
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Not supported in pipelines'
      ) {
        return [];
      }

      throw error;
    }
  }

  async #getPipelineForActiveModel(
    model: ManagedModel,
    additionalOptions?: Omit<Parameters<typeof this.pipelineFactory.getPipeline>[1], never>,
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

    return audioInput.startsWith('blob:') ? 'blob URL' : `string(${audioInput})`;
  }

  #describeTranscriptionResult(result: TranscriptionResult): string {
    if (typeof result === 'string') {
      return `string(length=${result.length})`;
    }

    return `object(textLength=${result.text?.length ?? 0}, chunks=${result.chunks?.length ?? 0})`;
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

  async #nameSpeakers(
    meeting: Meeting,
    transcript: string,
    segments: Omit<TranscriptSegment, 'speakerName'>[],
  ): Promise<Map<string, string>> {
    const speakers = [...new Set(segments.map((segment) => segment.speaker))];

    if (speakers.length === 0) {
      return new Map();
    }

    const activeModel = await this.#requireActiveModel('gemma4');

    try {
      const pipeline = (await this.pipelineFactory.getPipeline(
        activeModel.manifest,
      )) as CallablePipeline;
      const result = (await pipeline(
        this.#createSpeakerNamingPrompt(
          meeting,
          transcript,
          segments,
          speakers,
        ),
        {
          max_new_tokens: 256,
          return_full_text: false,
        },
      )) as TextGenerationResult;
      const text = this.#getGeneratedText(result);
      const parsed = this.#parseSpeakerNames(text);

      return new Map(
        speakers.map((speaker) => [speaker, parsed.get(speaker) ?? speaker]),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Not supported in pipelines'
      ) {
        return new Map(speakers.map((speaker) => [speaker, speaker]));
      }

      throw error;
    }
  }

  #createSpeakerNamingPrompt(
    meeting: Meeting,
    transcript: string,
    segments: Omit<TranscriptSegment, 'speakerName'>[],
    speakers: string[],
  ): string {
    return [
      'Infer human names for transcript speaker labels when the name is explicit.',
      'Return only JSON in this shape: [{"speaker":"SPEAKER_0","name":"Alice"}].',
      `Meeting title: ${meeting.title ?? 'Untitled meeting'}`,
      `Speakers: ${speakers.join(', ')}`,
      'Segments:',
      ...segments.map((segment) => `${segment.speaker}: ${segment.text}`),
      'Transcript:',
      transcript,
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

  #toTimestampedWord(value: unknown): TimestampedWord | null {
    if (typeof value !== 'object' || value === null) {
      return null;
    }

    const record = value as Record<string, unknown>;
    const word = record.word;
    const timestampInMs = record.timestampInMs;
    const start = record.start;

    if (typeof word !== 'string') {
      return null;
    }

    if (typeof timestampInMs === 'number') {
      return { word, timestampInMs };
    }

    if (typeof start === 'number') {
      return { word, timestampInMs: Math.round(start * 1000) };
    }

    return null;
  }

}
