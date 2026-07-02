import type { MeetingAudio } from './models/meeting-audio';
import type { TimestampedWord } from './models/timestamped-word';
import type { Transcript } from './models/transcript';
import type { TranscriptSegment } from './models/transcript-segment';
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
import { requireActiveModelForLanguage } from './model-utils';

const ALIGNMENT_CHUNK_SECONDS = 10;
const ALIGNMENT_CHUNK_OVERLAP_SECONDS = 1;

type CtcWord = { text: string; startSeconds: number; endSeconds: number };

type TranscriptWord = {
  word: string;
  segmentStartSeconds: number;
  segmentEndSeconds: number;
};
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
    transcript: Transcript,
    meetingAudio: MeetingAudio,
    debug?: AudioDebugCallback,
    inputSampleRate?: number,
  ): Promise<TimestampedWord[]> {
    const language = transcript.language;
    const activeModel = await requireActiveModelForLanguage(
      this.modelManager,
      'text-audio-sync',
      language,
    );
    debug?.(
      `[alignment] using ${activeModel.manifest.model}/${activeModel.manifest.version} for language=${language ?? 'unknown'}.`,
    );
    const transcriptWords = expandTranscriptWords(transcript);

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

    const chunkSamples = Math.max(
      1,
      Math.floor(ALIGNMENT_CHUNK_SECONDS * sampleRate),
    );
    // Overlap consecutive chunks so a word straddling a chunk boundary is
    // decoded intact by at least one chunk; each word is kept only from the
    // chunk where its midpoint falls outside the overlap margin.
    const overlapSamples = Math.min(
      Math.floor(ALIGNMENT_CHUNK_OVERLAP_SECONDS * sampleRate),
      Math.floor(chunkSamples / 4),
    );
    const strideSamples = Math.max(1, chunkSamples - 2 * overlapSamples);
    const ctcWords: CtcWord[] = [];

    debug?.(
      `[alignment] processing ${(audio.length / sampleRate).toFixed(2)}s audio in ${ALIGNMENT_CHUNK_SECONDS}s chunk(s) with ${ALIGNMENT_CHUNK_OVERLAP_SECONDS}s overlap.`,
    );

    for (let startSample = 0; ; startSample += strideSamples) {
      const endSample = Math.min(audio.length, startSample + chunkSamples);
      const chunk = audio.subarray(startSample, endSample);
      const chunkOffsetSeconds = startSample / sampleRate;
      const keepStartSeconds =
        startSample === 0
          ? 0
          : chunkOffsetSeconds + overlapSamples / sampleRate;
      const keepEndSeconds =
        endSample >= audio.length
          ? Number.POSITIVE_INFINITY
          : chunkOffsetSeconds + (chunkSamples - overlapSamples) / sampleRate;

      try {
        const inputs = await processor(chunk);
        const output = await model(inputs);
        const logits = output.logits as TensorLike | undefined;

        if (logits !== undefined && logits.dims.length >= 3) {
          const chunkWords = extractCtcWords(
            logits,
            tokenizer,
            chunk.length / sampleRate,
          );

          ctcWords.push(
            ...chunkWords
              .map((word) => ({
                text: word.text,
                startSeconds: word.startSeconds + chunkOffsetSeconds,
                endSeconds: word.endSeconds + chunkOffsetSeconds,
              }))
              .filter((word) => {
                const midpointSeconds =
                  (word.startSeconds + word.endSeconds) / 2;

                return (
                  midpointSeconds >= keepStartSeconds &&
                  midpointSeconds < keepEndSeconds
                );
              }),
          );
        }
      } catch (error) {
        debug?.(
          `[alignment] skipping ${(chunk.length / sampleRate).toFixed(2)}s chunk at ${(startSample / sampleRate).toFixed(2)}s after ONNX Runtime failure: ${getErrorMessage(error)}`,
        );
      }

      if (endSample >= audio.length) {
        break;
      }
    }

    ctcWords.sort((first, second) => first.startSeconds - second.startSeconds);

    return alignTranscriptWordsToCtc(
      transcriptWords,
      ctcWords,
      audio.length / sampleRate,
      debug,
    );
  }
}

function expandTranscriptWords(transcript: Transcript): TranscriptWord[] {
  const segments: TranscriptSegment[] =
    transcript.segments.length > 0
      ? transcript.segments
      : [
          {
            text: transcript.text,
            startSeconds: 0,
            endSeconds: 0,
            speaker: '',
            speakerName: '',
          },
        ];
  const result: TranscriptWord[] = [];

  for (const segment of segments) {
    const words = segment.text.match(/\S+/g) ?? [];

    for (const word of words) {
      result.push({
        word,
        segmentStartSeconds: segment.startSeconds,
        segmentEndSeconds: segment.endSeconds,
      });
    }
  }

  return result;
}

// Minimum average margin (char logit − blank logit) across a word's frames.
// During real speech characters decisively outscore blank; during music/noise
// they barely win or lose. -2 allows speech where some frames are borderline
// while still filtering clearly non-speech regions (music/noise).
const CTC_MIN_CONFIDENCE = -2;

// Real spoken words last longer than the model's frame stride. Drop anything
// shorter than this — single-frame "words" almost always come from noise that
// the model decoded into a stray token between two `|` delimiters.
const CTC_MIN_WORD_SECONDS = 0.04;

// Fallback per-word duration when a transcript segment hint provides no usable
// span (e.g. zero-duration segment). Keeps words spread out rather than
// stacking on the same timestamp.
const UNMATCHED_WORD_FALLBACK_SECONDS = 0.2;

function extractCtcWords(
  logits: TensorLike,
  tokenizer: CtcTokenizer,
  durationSeconds: number,
): CtcWord[] {
  const vocab = tokenizer.get_vocab();
  const wordDelimiterToken = tokenizer.word_delimiter_token ?? '|';
  const startToken = vocab instanceof Map
    ? vocab.get(wordDelimiterToken)
    : (vocab as unknown as Record<string, number>)[wordDelimiterToken];
  const specialIds = new Set(tokenizer.all_special_ids ?? []);
  const padTokenId = tokenizer.pad_token_id ?? -1;
  const hasPadToken = padTokenId >= 0 && padTokenId < (logits.dims[logits.dims.length - 1] ?? 0);

  // Reverse lookup: token id → token string. get_vocab() returns a Map whose
  // entries are not own properties, so hasOwnProperty + Object.keys don't work.
  const idToToken = new Map<number, string>();
  if (vocab instanceof Map) {
    vocab.forEach((id, token) => idToToken.set(id, token));
  } else {
    for (const [token, id] of Object.entries(
      vocab as unknown as Record<string, number>,
    )) {
      idToToken.set(id, token);
    }
  }

  const dims = logits.dims;
  const timeSteps = dims[dims.length - 2];
  const numTokens = dims[dims.length - 1];
  const data = Array.from(logits.data);
  const words: CtcWord[] = [];
  let currentWord = '';
  let wordStart = 0;
  let wordEnd = 0;
  let wordConfidenceSum = 0;
  let wordFrameCount = 0;
  let prevToken = '';

  const finalizeWord = (): void => {
    if (currentWord.length === 0) {
      return;
    }
    const avgConfidence =
      !hasPadToken || wordFrameCount === 0
        ? CTC_MIN_CONFIDENCE
        : wordConfidenceSum / wordFrameCount;
    const startSecondsValue = (wordStart / timeSteps) * durationSeconds;
    const endSecondsValue = ((wordEnd + 1) / timeSteps) * durationSeconds;
    const durationSecondsValue = endSecondsValue - startSecondsValue;
    // A real spoken word lasts at least ~40ms and typically uses ≥2 emitted
    // frames. Anything shorter is noise/music decoded as tiny garbage tokens
    // — drop it so transcript words don't squander matches against junk.
    const tooShort =
      durationSecondsValue < CTC_MIN_WORD_SECONDS || wordFrameCount < 2;
    if (avgConfidence >= CTC_MIN_CONFIDENCE && !tooShort) {
      words.push({
        text: normalizeCtcToken(currentWord),
        startSeconds: startSecondsValue,
        endSeconds: endSecondsValue,
      });
    }
    currentWord = '';
    wordConfidenceSum = 0;
    wordFrameCount = 0;
    prevToken = '';
  };

  for (let time = 0; time < timeSteps; time += 1) {
    const offset = time * numTokens;
    const bestIndex = argmax(data, offset, numTokens);
    const relBestIndex = bestIndex - offset;
    const tokenId = relBestIndex !== padTokenId ? relBestIndex : -1;

    if (tokenId === startToken) {
      finalizeWord();
      wordStart = time + 1;
      prevToken = '';
      continue;
    }

    if (tokenId === -1) {
      // CTC blank token — skip, does not finalize the word
      prevToken = '';
      continue;
    }

    if (specialIds.has(tokenId)) {
      continue;
    }

    const token = idToToken.get(tokenId) ?? '';

    if (token.length === 0) {
      continue;
    }

    const normalized = normalizeCtcToken(token);
    if (normalized.length === 0) {
      continue;
    }

    // CTC decoding: collapse consecutive repeated tokens
    if (normalized === prevToken) {
      continue;
    }
    prevToken = normalized;

    if (currentWord.length === 0) {
      wordStart = time;
    }
    wordEnd = time;
    currentWord += normalized;
    wordFrameCount += 1;

    if (hasPadToken) {
      const charLogit = data[bestIndex] ?? 0;
      const blankLogit = data[offset + padTokenId] ?? 0;
      wordConfidenceSum += charLogit - blankLogit;
    }
  }

  finalizeWord();

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

type CtcRange = { startIndex: number; endIndex: number };
type HintWindow = { startSeconds: number; endSeconds: number };

const ALIGNMENT_MAX_MERGE = 4;

// Half-width of the alignment band: a transcript word may only pair with CTC
// words this far outside its Whisper segment window. Keeps the DP tractable
// and makes far-away repetitions of the same phrase unreachable.
const ALIGNMENT_BAND_SECONDS = 10;

// Soft time cost inside the band: ~2s of deviation from the segment hint
// costs one character edit, so it only decides between near-tied text matches.
const ALIGNMENT_TIME_COST_PER_SECOND = 0.5;

// Leaving a transcript word unanchored is the outcome we're trying to avoid,
// so it costs more than the worst acceptable anchor (2 edits + a small time
// cost). Skipping a junk CTC word is cheap and expected (music/noise decode
// into garbage tokens) — if it weren't, anchoring the last words before a
// noisy stretch would cost more than dropping them, since trailing CTC is
// skippable for free once the aligner stops consuming words.
const ALIGNMENT_GAP_COST_TRANSCRIPT = 2.0;
const ALIGNMENT_GAP_COST_CTC = 0.4;

// A stretch this long without any surviving CTC word is a dead zone (silence,
// music): positive evidence of non-speech. Interpolated words are never
// placed inside one — runs squeeze into the speech-active parts of their
// window. Real speech pauses stay under this.
const ALIGNMENT_DEAD_ZONE_MIN_SECONDS = 2;

const MOVE_NONE = 0;
const MOVE_SKIP_TRANSCRIPT = 1;
const MOVE_SKIP_CTC = 2;
// Anchor moves are encoded as MOVE_ANCHOR_BASE + mergeLength (3..6).
const MOVE_ANCHOR_BASE = 2;

function alignTranscriptWordsToCtc(
  transcriptWords: TranscriptWord[],
  ctcWords: CtcWord[],
  audioDurationSeconds: number,
  debug?: AudioDebugCallback,
): TimestampedWord[] {
  const matchedRange =
    ctcWords.length > 0
      ? globalAlignWords(transcriptWords, ctcWords, audioDurationSeconds, debug)
      : new Array<CtcRange | null>(transcriptWords.length).fill(null);

  const { startSeconds, endSeconds } = assignWordTimes(
    transcriptWords,
    ctcWords,
    matchedRange,
    audioDurationSeconds,
  );

  // Defensive monotonicity pass — anchor-based interpolation is already
  // monotonic by construction; this only guards against rounding artifacts.
  for (let i = 1; i < transcriptWords.length; i += 1) {
    if (startSeconds[i] < endSeconds[i - 1]) {
      startSeconds[i] = endSeconds[i - 1];
    }
    if (endSeconds[i] < startSeconds[i]) {
      endSeconds[i] = startSeconds[i];
    }
  }

  const matchedCount = matchedRange.reduce(
    (sum, range) => (range !== null ? sum + 1 : sum),
    0,
  );
  debug?.(
    `[alignment] anchored ${matchedCount}/${transcriptWords.length} transcript word(s) to CTC; interpolated ${transcriptWords.length - matchedCount}.`,
  );

  return transcriptWords.map((entry, i) => ({
    word: entry.word,
    timestampInMs: Math.round(startSeconds[i] * 1000),
    endTimeInMs: Math.round(endSeconds[i] * 1000),
  }));
}

// Banded global alignment (Needleman-Wunsch) between the transcript word
// sequence and the CTC word sequence. Moves per cell: anchor one transcript
// word to 1..MAX_MERGE consecutive CTC words (compounds like "stresshormoon"
// ↔ "stress" + "hormoon"), leave a transcript word unanchored, or skip a junk
// CTC word. Leading and trailing CTC words are skippable for free so
// non-speech audio at the recording edges costs nothing.
function globalAlignWords(
  transcriptWords: TranscriptWord[],
  ctcWords: CtcWord[],
  audioDurationSeconds: number,
  debug?: AudioDebugCallback,
): (CtcRange | null)[] {
  const wordCount = transcriptWords.length;
  const ctcCount = ctcWords.length;
  const normalizedTranscript = transcriptWords.map((entry) =>
    normalizeAlignmentWord(entry.word),
  );
  const normalizedCtc = ctcWords.map((word) =>
    normalizeAlignmentWord(word.text),
  );
  const hints = buildHintWindows(transcriptWords, audioDurationSeconds);
  const ctcStartTimes = ctcWords.map((word) => word.startSeconds);

  // Cost rows are full-width for simplicity; backpointers are stored banded
  // per row, which is what keeps memory linear in the band width.
  let previousRow = new Float64Array(ctcCount + 1); // all 0: free leading skip
  const bandStart = new Array<number>(wordCount + 1).fill(0);
  const backpointers = new Array<Uint8Array | null>(wordCount + 1).fill(null);
  let previousBestColumn = 0;

  for (let row = 1; row <= wordCount; row += 1) {
    const hint = hints[row - 1];
    let columnStart = lowerBound(
      ctcStartTimes,
      hint.startSeconds - ALIGNMENT_BAND_SECONDS,
    );
    let columnEnd = Math.min(
      ctcCount,
      lowerBound(ctcStartTimes, hint.endSeconds + ALIGNMENT_BAND_SECONDS),
    );

    // Keep the previous row's best column reachable so one path always
    // survives even when consecutive hint windows are disjoint.
    columnStart = Math.min(columnStart, previousBestColumn);
    columnEnd = Math.max(
      columnEnd,
      Math.min(ctcCount, previousBestColumn + ALIGNMENT_MAX_MERGE),
    );

    const currentRow = new Float64Array(ctcCount + 1).fill(
      Number.POSITIVE_INFINITY,
    );
    const rowPointers = new Uint8Array(columnEnd - columnStart + 1);
    const word = normalizedTranscript[row - 1];

    for (let column = columnStart; column <= columnEnd; column += 1) {
      let bestCost = previousRow[column] + ALIGNMENT_GAP_COST_TRANSCRIPT;
      let bestMove = MOVE_SKIP_TRANSCRIPT;

      if (word.length > 0) {
        let combined = '';

        for (
          let mergeLength = 1;
          mergeLength <= ALIGNMENT_MAX_MERGE && column - mergeLength >= 0;
          mergeLength += 1
        ) {
          combined = normalizedCtc[column - mergeLength] + combined;

          const maxLength = Math.max(combined.length, word.length);
          const threshold = maxLength >= 8 ? 2 : maxLength >= 4 ? 1 : 0;

          // Merging more CTC words only makes the string longer — bail once
          // it overshoots the target beyond repair.
          if (combined.length > word.length + threshold) {
            break;
          }

          if (word.length - combined.length > threshold) {
            continue;
          }

          const distance =
            threshold === 0
              ? word === combined
                ? 0
                : Number.POSITIVE_INFINITY
              : levenshteinDistance(word, combined);

          if (distance > threshold) {
            continue;
          }

          const timeCost =
            ALIGNMENT_TIME_COST_PER_SECOND *
            hintDeviationSeconds(
              ctcWords[column - mergeLength].startSeconds,
              ctcWords[column - 1].endSeconds,
              hint,
            );
          const cost = previousRow[column - mergeLength] + distance + timeCost;

          if (cost < bestCost) {
            bestCost = cost;
            bestMove = MOVE_ANCHOR_BASE + mergeLength;
          }
        }
      }

      currentRow[column] = bestCost;
      rowPointers[column - columnStart] = bestMove;
    }

    // Skip junk CTC words left-to-right within the band.
    for (let column = columnStart + 1; column <= columnEnd; column += 1) {
      const cost = currentRow[column - 1] + ALIGNMENT_GAP_COST_CTC;

      if (cost < currentRow[column]) {
        currentRow[column] = cost;
        rowPointers[column - columnStart] = MOVE_SKIP_CTC;
      }
    }

    let bestColumn = columnStart;
    for (let column = columnStart + 1; column <= columnEnd; column += 1) {
      if (currentRow[column] < currentRow[bestColumn]) {
        bestColumn = column;
      }
    }

    if (!Number.isFinite(currentRow[bestColumn])) {
      debug?.(
        `[alignment] global alignment found no viable path at word ${row}; falling back to segment hints.`,
      );
      return new Array<CtcRange | null>(wordCount).fill(null);
    }

    bandStart[row] = columnStart;
    backpointers[row] = rowPointers;
    previousBestColumn = bestColumn;
    previousRow = currentRow;
  }

  // Trailing CTC words are skippable for free: end at the cheapest column.
  let column = 0;
  for (let candidate = 1; candidate <= ctcCount; candidate += 1) {
    if (previousRow[candidate] < previousRow[column]) {
      column = candidate;
    }
  }

  const matchedRange = new Array<CtcRange | null>(wordCount).fill(null);
  let row = wordCount;

  while (row > 0) {
    const rowPointers = backpointers[row];
    const columnStart = bandStart[row];
    const move =
      rowPointers !== null &&
      column >= columnStart &&
      column - columnStart < rowPointers.length
        ? rowPointers[column - columnStart]
        : MOVE_NONE;

    if (move === MOVE_SKIP_TRANSCRIPT) {
      row -= 1;
    } else if (move === MOVE_SKIP_CTC) {
      column -= 1;
    } else if (move > MOVE_ANCHOR_BASE) {
      const mergeLength = move - MOVE_ANCHOR_BASE;

      matchedRange[row - 1] = {
        startIndex: column - mergeLength,
        endIndex: column - 1,
      };
      row -= 1;
      column -= mergeLength;
    } else {
      // Unreachable when traceback starts from a finite cell.
      break;
    }
  }

  return matchedRange;
}

// Whisper segment hints locate each word coarsely. When a segment carries no
// usable duration, estimate the word's position proportionally across the
// recording so the alignment band still lands in a plausible region.
function buildHintWindows(
  transcriptWords: TranscriptWord[],
  audioDurationSeconds: number,
): HintWindow[] {
  const wordCount = transcriptWords.length;

  return transcriptWords.map((entry, index) => {
    if (entry.segmentEndSeconds > entry.segmentStartSeconds) {
      return {
        startSeconds: entry.segmentStartSeconds,
        endSeconds: entry.segmentEndSeconds,
      };
    }

    const estimated =
      wordCount > 1 ? (index / (wordCount - 1)) * audioDurationSeconds : 0;

    return { startSeconds: estimated, endSeconds: estimated };
  });
}

function hintDeviationSeconds(
  ctcStartSeconds: number,
  ctcEndSeconds: number,
  hint: HintWindow,
): number {
  if (ctcEndSeconds < hint.startSeconds) {
    return hint.startSeconds - ctcEndSeconds;
  }

  if (ctcStartSeconds > hint.endSeconds) {
    return ctcStartSeconds - hint.endSeconds;
  }

  return 0;
}

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const mid = (low + high) >> 1;

    if (values[mid] < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

// Anchored words take their CTC times verbatim; runs of unanchored words are
// interpolated between the surrounding anchors (CTC wins). Segment hints are
// only consulted when an anchor side is missing: leading/trailing runs, or a
// transcript with no anchors at all.
function assignWordTimes(
  transcriptWords: TranscriptWord[],
  ctcWords: CtcWord[],
  matchedRange: (CtcRange | null)[],
  audioDurationSeconds: number,
): { startSeconds: number[]; endSeconds: number[] } {
  const wordCount = transcriptWords.length;
  const startSeconds = new Array<number>(wordCount).fill(0);
  const endSeconds = new Array<number>(wordCount).fill(0);

  if (!matchedRange.some((range) => range !== null)) {
    spreadRunAcrossSegmentHints(
      transcriptWords,
      0,
      wordCount,
      startSeconds,
      endSeconds,
    );
    return { startSeconds, endSeconds };
  }

  let cursor = 0;

  while (cursor < wordCount) {
    const range = matchedRange[cursor];

    if (range !== null) {
      startSeconds[cursor] = ctcWords[range.startIndex].startSeconds;
      endSeconds[cursor] = ctcWords[range.endIndex].endSeconds;
      cursor += 1;
      continue;
    }

    let runEnd = cursor;
    while (runEnd < wordCount && matchedRange[runEnd] === null) {
      runEnd += 1;
    }

    const nextRange = runEnd < wordCount ? matchedRange[runEnd] : null;
    const previousAnchorEnd = cursor > 0 ? endSeconds[cursor - 1] : null;
    const nextAnchorStart =
      nextRange !== null ? ctcWords[nextRange.startIndex].startSeconds : null;
    const runCount = runEnd - cursor;

    let windowStartSeconds: number;
    let windowEndSeconds: number;

    if (previousAnchorEnd !== null && nextAnchorStart !== null) {
      // Interior run: squeeze the run between the anchors, even when the gap
      // is tiny — tiny honest spans beat collapsed timestamps.
      windowStartSeconds = previousAnchorEnd;
      windowEndSeconds = Math.max(previousAnchorEnd, nextAnchorStart);
    } else if (nextAnchorStart !== null) {
      // Leading run: bounded on the right by the first anchor; segment hints
      // suggest the start when they don't contradict the anchor.
      windowEndSeconds = nextAnchorStart;
      const hintStart = earliestSegmentStart(transcriptWords, cursor, runEnd);
      const fallbackStart =
        windowEndSeconds - runCount * UNMATCHED_WORD_FALLBACK_SECONDS;
      windowStartSeconds = Math.max(
        0,
        Math.min(
          hintStart !== null && hintStart < windowEndSeconds
            ? hintStart
            : fallbackStart,
          windowEndSeconds,
        ),
      );
    } else {
      // Trailing run: bounded on the left by the last anchor; segment hints
      // (capped to the recording length) suggest the end.
      windowStartSeconds = previousAnchorEnd ?? 0;
      const hintEnd = latestSegmentEnd(transcriptWords, cursor, runEnd);
      const fallbackEnd =
        windowStartSeconds + runCount * UNMATCHED_WORD_FALLBACK_SECONDS;
      windowEndSeconds = Math.max(
        windowStartSeconds,
        Math.min(
          hintEnd !== null && hintEnd > windowStartSeconds
            ? hintEnd
            : fallbackEnd,
          Math.max(audioDurationSeconds, windowStartSeconds),
        ),
      );
    }

    distributeRunAcrossActiveWindows(
      transcriptWords,
      cursor,
      runEnd,
      windowStartSeconds,
      windowEndSeconds,
      ctcWords,
      // A leading run is bounded by an anchor on the right only — when no
      // speech evidence exists in its window, the words belong next to that
      // anchor, not at the window's far, silent start.
      previousAnchorEnd === null,
      startSeconds,
      endSeconds,
    );
    cursor = runEnd;
  }

  return { startSeconds, endSeconds };
}

// The speech-active parts of a window: CTC words mark where speech evidence
// exists, and stretches without any are dead zones. Returns clipped, merged
// intervals; empty when the window holds no speech evidence at all.
function activeSubwindows(
  ctcWords: CtcWord[],
  windowStartSeconds: number,
  windowEndSeconds: number,
): HintWindow[] {
  const intervals: HintWindow[] = [];

  for (const word of ctcWords) {
    if (
      word.endSeconds <= windowStartSeconds ||
      word.startSeconds >= windowEndSeconds
    ) {
      continue;
    }

    const startSeconds = Math.max(word.startSeconds, windowStartSeconds);
    const endSeconds = Math.min(word.endSeconds, windowEndSeconds);
    const last = intervals[intervals.length - 1];

    if (
      last !== undefined &&
      startSeconds - last.endSeconds <= ALIGNMENT_DEAD_ZONE_MIN_SECONDS
    ) {
      last.endSeconds = Math.max(last.endSeconds, endSeconds);
    } else {
      intervals.push({ startSeconds, endSeconds });
    }
  }

  return intervals.filter(
    (interval) => interval.endSeconds > interval.startSeconds,
  );
}

// Distribute a run of unanchored words across the speech-active parts of its
// window, so no word lands inside a dead zone. Words are assigned to
// subwindows by their position in the run's virtual (dead-zone-free)
// timeline, keeping each word entirely inside one subwindow.
function distributeRunAcrossActiveWindows(
  transcriptWords: TranscriptWord[],
  runStart: number,
  runEnd: number,
  windowStartSeconds: number,
  windowEndSeconds: number,
  ctcWords: CtcWord[],
  clusterAtWindowEnd: boolean,
  startSeconds: number[],
  endSeconds: number[],
): void {
  const subwindows = activeSubwindows(
    ctcWords,
    windowStartSeconds,
    windowEndSeconds,
  );

  if (subwindows.length === 0) {
    // No speech evidence anywhere in the window: cluster the words tightly
    // against the anchored side rather than spreading them over the silence.
    const runCount = runEnd - runStart;
    const clusterSpanSeconds = Math.min(
      windowEndSeconds - windowStartSeconds,
      runCount * UNMATCHED_WORD_FALLBACK_SECONDS,
    );

    distributeRunAcrossWindow(
      transcriptWords,
      runStart,
      runEnd,
      clusterAtWindowEnd
        ? windowEndSeconds - clusterSpanSeconds
        : windowStartSeconds,
      clusterAtWindowEnd
        ? windowEndSeconds
        : windowStartSeconds + clusterSpanSeconds,
      startSeconds,
      endSeconds,
    );
    return;
  }

  if (subwindows.length === 1) {
    distributeRunAcrossWindow(
      transcriptWords,
      runStart,
      runEnd,
      subwindows[0].startSeconds,
      subwindows[0].endSeconds,
      startSeconds,
      endSeconds,
    );
    return;
  }

  const virtualEndSeconds: number[] = [];
  let totalActiveSeconds = 0;

  for (const subwindow of subwindows) {
    totalActiveSeconds += subwindow.endSeconds - subwindow.startSeconds;
    virtualEndSeconds.push(totalActiveSeconds);
  }

  let totalWeight = 0;

  for (let i = runStart; i < runEnd; i += 1) {
    totalWeight += Math.max(1, transcriptWords[i].word.length);
  }

  // Assign each word to a subwindow by its virtual midpoint; assignments are
  // monotonic, so each subwindow receives a contiguous slice of the run.
  const sliceStart = new Array<number>(subwindows.length).fill(runEnd);
  const sliceEnd = new Array<number>(subwindows.length).fill(runStart);
  let accumulatedWeight = 0;
  let subwindowIndex = 0;

  for (let i = runStart; i < runEnd; i += 1) {
    const weight = Math.max(1, transcriptWords[i].word.length);
    const midVirtualSeconds =
      ((accumulatedWeight + weight / 2) / totalWeight) * totalActiveSeconds;

    accumulatedWeight += weight;

    while (
      subwindowIndex < subwindows.length - 1 &&
      midVirtualSeconds > virtualEndSeconds[subwindowIndex]
    ) {
      subwindowIndex += 1;
    }

    sliceStart[subwindowIndex] = Math.min(sliceStart[subwindowIndex], i);
    sliceEnd[subwindowIndex] = Math.max(sliceEnd[subwindowIndex], i + 1);
  }

  for (let s = 0; s < subwindows.length; s += 1) {
    if (sliceStart[s] < sliceEnd[s]) {
      distributeRunAcrossWindow(
        transcriptWords,
        sliceStart[s],
        sliceEnd[s],
        subwindows[s].startSeconds,
        subwindows[s].endSeconds,
        startSeconds,
        endSeconds,
      );
    }
  }
}

// Distribute a run of unanchored words across a time window, proportional to
// character length so long words get more time than short ones.
function distributeRunAcrossWindow(
  transcriptWords: TranscriptWord[],
  runStart: number,
  runEnd: number,
  windowStartSeconds: number,
  windowEndSeconds: number,
  startSeconds: number[],
  endSeconds: number[],
): void {
  const spanSeconds = Math.max(0, windowEndSeconds - windowStartSeconds);
  let totalWeight = 0;

  for (let i = runStart; i < runEnd; i += 1) {
    totalWeight += Math.max(1, transcriptWords[i].word.length);
  }

  let accumulatedWeight = 0;

  for (let i = runStart; i < runEnd; i += 1) {
    startSeconds[i] =
      windowStartSeconds + (spanSeconds * accumulatedWeight) / totalWeight;
    accumulatedWeight += Math.max(1, transcriptWords[i].word.length);
    endSeconds[i] =
      windowStartSeconds + (spanSeconds * accumulatedWeight) / totalWeight;
  }
}

// Last-resort placement when CTC produced no anchors at all: spread words
// across their own segment windows, with a small per-word fallback span for
// segments without a usable duration.
function spreadRunAcrossSegmentHints(
  transcriptWords: TranscriptWord[],
  runStart: number,
  runEnd: number,
  startSeconds: number[],
  endSeconds: number[],
): void {
  let groupStart = runStart;

  while (groupStart < runEnd) {
    const groupSegStart = transcriptWords[groupStart].segmentStartSeconds;
    const groupSegEnd = transcriptWords[groupStart].segmentEndSeconds;

    let groupEnd = groupStart + 1;
    while (
      groupEnd < runEnd &&
      transcriptWords[groupEnd].segmentStartSeconds === groupSegStart &&
      transcriptWords[groupEnd].segmentEndSeconds === groupSegEnd
    ) {
      groupEnd += 1;
    }

    const groupCount = groupEnd - groupStart;
    const minSpan = groupCount * UNMATCHED_WORD_FALLBACK_SECONDS;
    const span = Math.max(minSpan, groupSegEnd - groupSegStart);

    for (let i = groupStart; i < groupEnd; i += 1) {
      const offset = ((i - groupStart) * span) / groupCount;
      const nextOffset = ((i - groupStart + 1) * span) / groupCount;
      startSeconds[i] = groupSegStart + offset;
      endSeconds[i] = groupSegStart + nextOffset;
    }

    groupStart = groupEnd;
  }
}

function earliestSegmentStart(
  transcriptWords: TranscriptWord[],
  runStart: number,
  runEnd: number,
): number | null {
  let earliest: number | null = null;

  for (let i = runStart; i < runEnd; i += 1) {
    const entry = transcriptWords[i];

    if (entry.segmentEndSeconds <= entry.segmentStartSeconds) {
      continue;
    }

    if (earliest === null || entry.segmentStartSeconds < earliest) {
      earliest = entry.segmentStartSeconds;
    }
  }

  return earliest;
}

function latestSegmentEnd(
  transcriptWords: TranscriptWord[],
  runStart: number,
  runEnd: number,
): number | null {
  let latest: number | null = null;

  for (let i = runStart; i < runEnd; i += 1) {
    const entry = transcriptWords[i];

    if (entry.segmentEndSeconds <= entry.segmentStartSeconds) {
      continue;
    }

    if (latest === null || entry.segmentEndSeconds > latest) {
      latest = entry.segmentEndSeconds;
    }
  }

  return latest;
}

function normalizeAlignmentWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
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
