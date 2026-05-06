import type { MeetingAudio } from './models/meeting-audio';
import type { TimestampedText } from './models/timestamped-text';
import { PipelineFactory } from './pipeline-factory';
import { ModelManager } from '@notetaker/model-manager';
import {
  AutomaticSpeechRecognitionPipeline,
  WhisperTextStreamer
} from '@huggingface/transformers';
import type { AudioDebugCallback } from './audio-utils';
import {
  withAudioInput,
  describeMeetingAudio,
  describeAudioInput,
  sanitizeAudioSamples,
} from './audio-utils';
import {
  getPipelineForActiveModel,
  describeTranscriptionResult,
} from './model-utils';

const TRANSCRIPTION_CHUNK_SECONDS = 30;
const TRANSCRIPTION_STRIDE_SECONDS = 5;
const TRANSCRIPTION_CHUNK_ADVANCE_SECONDS =
  TRANSCRIPTION_CHUNK_SECONDS - 2 * TRANSCRIPTION_STRIDE_SECONDS;

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

export type TranscriptionOptions = {
  fragmentCallback: (fragments: TimestampedText[]) => void;
  debug?: AudioDebugCallback;
  language?: string;
  task?: 'transcribe' | 'translate';
};

export type LanguageDetectionOptions = {
  sampleSeconds?: number;
  debug?: AudioDebugCallback;
};

export class TranscriptionService {
  constructor(
    private pipelineFactory: PipelineFactory,
    private modelManager: ModelManager,
  ) {}

  async transcribeAudio(
    meetingAudio: MeetingAudio,
    options: TranscriptionOptions,
  ): Promise<string> {
    const { fragmentCallback, debug, language, task } = options;

    debug?.(
      `[transcription] input ${describeMeetingAudio(meetingAudio)}`,
    );
    debug?.('[transcription] loading Whisper pipeline...');

    const pipeline = (await getPipelineForActiveModel(
      this.pipelineFactory,
      this.modelManager,
      'transcription',
    )) as AutomaticSpeechRecognitionPipeline;

    debug?.('[transcription] Whisper pipeline ready.');

    let emittedLiveTranscript = false;
    const streamedFragments: TimestampedText[] = [];
    let pendingStreamedText = '';
    let currentChunkStartSeconds = 0;
    let audioChunkIndex = 0;
    const tokenizer = (pipeline as { tokenizer?: unknown }).tokenizer;

    debug?.(
      `[transcription] tokenizer ${tokenizer === undefined ? 'missing' : 'available'}; creating WhisperTextStreamer.`,
    );

    const streamer = new WhisperTextStreamer((pipeline as any).tokenizer, {
      skip_prompt: true,
      callback_function: (text: string) => {
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

        const sentences = extractCompletedSentences(pendingStreamedText);
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
      on_chunk_start: (time: number) => {
        const chunkBaseSeconds =
          audioChunkIndex * TRANSCRIPTION_CHUNK_ADVANCE_SECONDS;
        currentChunkStartSeconds = chunkBaseSeconds + time;
        debug?.(
          `[transcription] streamer segment start local=${time.toFixed(2)}s; absolute=${currentChunkStartSeconds.toFixed(2)}s (audio chunk #${audioChunkIndex}).`,
        );
      },
      on_chunk_end: (time: number) => {
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

    const result = (await withAudioInput(
      meetingAudio,
      (audioInput) => {
        debug?.(
          `[transcription] invoking pipeline with ${describeAudioInput(audioInput)}...`,
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
      `[transcription] pipeline resolved with ${describeTranscriptionResult(result)}; emittedLiveTranscript=${emittedLiveTranscript}.`,
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
    const fragments = extractTranscriptFragments(result);
    debug?.(
      `[transcription] emitting ${fragments.length} timestamped result chunk(s).`,
    );

    fragmentCallback(
      fragments.length > 0 ? fragments : [{ timestampInMs: 0, text }],
    );

    return text;
  }

  async detectAudioLanguage(
    meetingAudio: MeetingAudio,
    options: LanguageDetectionOptions = {},
  ): Promise<string | null> {
    const debug = options.debug;
    const sampleSeconds = options.sampleSeconds ?? 30;

    debug?.('[language-detection] loading Whisper pipeline...');

    const pipeline = (await getPipelineForActiveModel(
      this.pipelineFactory,
      this.modelManager,
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
    const audio = await loadAudioForLanguageDetection(
      meetingAudio,
      sampleRate,
      debug,
    );

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
    const decoderInputIds = new (await import('@huggingface/transformers')).Tensor(
      'int64',
      BigInt64Array.from([BigInt(sotToken)]),
      [1, 1],
    );
    const output = (await model.generate({
      ...inputs,
      decoder_input_ids: decoderInputIds,
      max_new_tokens: 1,
    })) as { data: ArrayLike<number>; dims: number[] };

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
}

function extractCompletedSentences(text: string): {
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

function extractTranscriptFragments(value: unknown): TimestampedText[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  const record = value as Record<string, unknown>;

  if (Array.isArray(record.chunks)) {
    return record.chunks
      .map((chunk) => toTranscriptFragment(chunk))
      .filter((fragment): fragment is TimestampedText => fragment !== null);
  }

  return [];
}

function toTranscriptFragment(value: unknown): TimestampedText | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text : undefined;

  if (text === undefined) {
    return null;
  }

  const timestamp = record.timestamp;
  let timestampInMs: number | undefined;

  if (Array.isArray(timestamp) && timestamp.length >= 2) {
    const start = timestamp[0];
    if (typeof start === 'number' && start !== null) {
      timestampInMs = Math.round(start * 1000);
    }
  }

  return {
    timestampInMs: timestampInMs ?? 0,
    text,
  };
}

async function loadAudioForLanguageDetection(
  meetingAudio: MeetingAudio,
  sampleRate: number,
  debug?: AudioDebugCallback,
): Promise<Float32Array> {
  const audio = await withAudioInput(
    meetingAudio,
    (audioInput) =>
      audioInput instanceof Float32Array
        ? Promise.resolve(audioInput)
        : (async () => {
              const { read_audio } = await import('@huggingface/transformers');
              return read_audio(audioInput, sampleRate);
            })(),
    debug,
  );

  return sanitizeAudioSamples(audio);
}
