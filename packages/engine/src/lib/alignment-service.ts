import type { MeetingAudio } from './models/meeting-audio';
import type { TimestampedWord } from './models/timestamped-word';
import { ModelManager } from '@notetaker/model-manager';
import {
  AutoModelForCTC,
  AutoProcessor,
  AutoTokenizer,
} from '@huggingface/transformers';
import type { AudioDebugCallback } from './audio-utils';
import {
  withAudioInput,
  sanitizeAudioSamples,
  resampleAudioIfNeeded,
} from './audio-utils';
import { requireActiveModel } from './model-utils';

const ALIGNMENT_CHUNK_SECONDS = 10;

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

export class AlignmentService {
  constructor(private modelManager: ModelManager) {}

  async alignTranscriptToAudio(
    transcript: string,
    meetingAudio: MeetingAudio,
    debug?: AudioDebugCallback,
    inputSampleRate?: number,
  ): Promise<TimestampedWord[]> {
    const activeModel = await requireActiveModel(
      this.modelManager,
      'text-audio-sync',
    );
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
      (await AutoTokenizer.from_pretrained(modelId, loadOptions))) as CtcTokenizer;
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

    const audio = await loadAudioForAlignment(
      meetingAudio,
      sampleRate,
      inputSampleRate,
      debug,
    );

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
        const chunkWords = extractCtcWords(
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
          `[alignment] skipping ${(chunk.length / sampleRate).toFixed(2)}s chunk at ${(startSample / sampleRate).toFixed(2)}s after ONNX Runtime failure: ${getErrorMessage(error)}`,
        );
      }
    }

    return mapTranscriptWordsToCtcWords(transcriptWords, ctcWords);
  }
}

function extractCtcWords(
  logits: TensorLike,
  tokenizer: CtcTokenizer,
  durationSeconds: number,
): CtcWord[] {
  const vocab = tokenizer.get_vocab();
  const wordDelimiterToken = tokenizer.word_delimiter_token ?? '|';
  const startToken = vocab.get(wordDelimiterToken) ?? undefined;
  const specialIds = new Set(tokenizer.all_special_ids ?? []);
  const padTokenId = tokenizer.pad_token_id ?? -1;

  const dims = logits.dims;
  const timeSteps = dims[dims.length - 2];
  const numTokens = dims[dims.length - 1];
  const data = Array.from(logits.data);
  const words: CtcWord[] = [];
  let currentWord = '';
  let wordStart = 0;

  for (let time = 0; time < timeSteps; time += 1) {
    const offset = time * numTokens;
    const bestIndex = argmax(data, offset, numTokens);
    const tokenId = bestIndex - padTokenId !== 0 ? bestIndex : -1;

    if (tokenId === startToken || tokenId === -1) {
      if (currentWord.length > 0) {
        words.push({
          text: normalizeCtcToken(currentWord),
          startSeconds:
            (wordStart / timeSteps) * durationSeconds,
        });
        currentWord = '';
      }
      if (tokenId === startToken) {
        wordStart = time + 1;
      }
      continue;
    }

    if (specialIds.has(tokenId)) {
      continue;
    }

    const token = vocab.hasOwnProperty(String(tokenId))
      ? Object.keys(vocab).find((key) => vocab.get(key) === tokenId) ?? ''
      : '';

    if (token.length === 0) {
      continue;
    }

    const normalized = normalizeCtcToken(token);
    if (normalized.length === 0) {
      continue;
    }

    if (currentWord.length === 0) {
      wordStart = time;
    }
    currentWord += normalized;
  }

  if (currentWord.length > 0) {
    words.push({
      text: normalizeCtcToken(currentWord),
      startSeconds: (wordStart / timeSteps) * durationSeconds,
    });
  }

  return words;
}

function argmax(
  values: ArrayLike<number>,
  offset: number,
  length: number,
): number {
  let bestIndex = offset;
  let bestValue = values[offset] ?? Number.NEGATIVE_INFINITY;

  for (let index = 1; index < length; index += 1) {
    const value = values[offset + index] ?? Number.NEGATIVE_INFINITY;
    if (value > bestValue) {
      bestValue = value;
      bestIndex = offset + index;
    }
  }

  return bestIndex;
}

function normalizeCtcToken(token: string): string {
  return token.replace(/^##/, '');
}

function mapTranscriptWordsToCtcWords(
  transcriptWords: string[],
  ctcWords: CtcWord[],
): TimestampedWord[] {
  const result: TimestampedWord[] = [];

  for (const word of transcriptWords) {
    const normalizedWord = normalizeAlignmentWord(word);
    const searchStart = result.length > 0 ? result.length - 1 : 0;
    const index = findAlignedCtcWordIndex(
      normalizedWord,
      ctcWords,
      searchStart,
    );

    if (index >= 0 && index < ctcWords.length) {
      result.push({
        word: word,
        timestampInMs: Math.round(ctcWords[index].startSeconds * 1000),
      });
    }
  }

  return result;
}

function findAlignedCtcWordIndex(
  word: string,
  ctcWords: CtcWord[],
  startIndex: number,
): number {
  for (let index = startIndex; index < ctcWords.length; index += 1) {
    if (
      areSimilarAlignmentWords(
        word,
        normalizeAlignmentWord(ctcWords[index].text),
      )
    ) {
      return index;
    }
  }

  for (let index = startIndex - 1; index >= 0; index -= 1) {
    if (
      areSimilarAlignmentWords(
        word,
        normalizeAlignmentWord(ctcWords[index].text),
      )
    ) {
      return index;
    }
  }

  return -1;
}

function normalizeAlignmentWord(word: string): string {
  return word.toLowerCase().replace(/[^\w]/g, '');
}

function areSimilarAlignmentWords(
  first: string,
  second: string,
): boolean {
  if (first === second) {
    return true;
  }

  return levenshteinDistance(first, second) <= 1;
}

function levenshteinDistance(first: string, second: string): number {
  const rows = first.length + 1;
  const cols = second.length + 1;
  const distances = new Uint16Array(rows * cols);

  for (let row = 0; row < rows; row += 1) {
    distances[row * cols] = row;
  }

  for (let col = 0; col < cols; col += 1) {
    distances[col] = col;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = first[row - 1] === second[col - 1] ? 0 : 1;
      const deletion = distances[(row - 1) * cols + col] + 1;
      const insertion = distances[row * cols + col - 1] + 1;
      const substitution =
        distances[(row - 1) * cols + col - 1] + cost;
      distances[row * cols + col] = Math.min(
        deletion,
        insertion,
        substitution,
      );
    }
  }

  return distances[rows * cols - 1];
}

async function loadAudioForAlignment(
  meetingAudio: MeetingAudio,
  sampleRate: number,
  inputSampleRate: number | undefined,
  debug?: AudioDebugCallback,
): Promise<Float32Array> {
  const rawAudio = await withAudioInput(
    meetingAudio,
    (audioInput) =>
      audioInput instanceof Float32Array
        ? Promise.resolve(
            resampleAudioIfNeeded(audioInput, inputSampleRate, sampleRate),
          )
        : (async () => {
            const { read_audio } = await import('@huggingface/transformers');
            return read_audio(audioInput, sampleRate);
          })(),
    debug,
  );

  return sanitizeAudioSamples(rawAudio);
}

function getErrorMessage(error: unknown): string {
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
