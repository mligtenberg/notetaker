import type { ScanNote } from '@notetaker/filesystem';
import type { Transcript } from '../models/transcript';
import type { LanguageModel } from './language-model';
import { formatTimecode, renderSegments } from './transcript-index';

export interface RollingScanOptions {
  /** Base segments per window (may be enlarged to bound the window count). */
  windowSize?: number;
  /** Segments of overlap between consecutive windows. */
  overlap?: number;
  /** Upper bound on the number of windows; windows grow to keep full coverage. */
  maxWindows?: number;
  maxNewTokensPerNote?: number;
  maxNewTokensReduce?: number;
  /** Approx char budget per reduce call; larger note sets are reduced in tiers. */
  reduceCharBudget?: number;
  answerMaxChars?: number;
}

export interface RollingScanCallbacks {
  onStart?: (totalWindows: number) => void;
  onWindow?: (index: number, total: number, note: string | null) => void;
  signal?: AbortSignal;
}

export interface RollingScanResult {
  answer: string;
  notes: ScanNote[];
  windowCount: number;
}

const DEFAULTS = {
  windowSize: 30,
  overlap: 2,
  maxWindows: 40,
  maxNewTokensPerNote: 160,
  maxNewTokensReduce: 512,
  reduceCharBudget: 6000,
  answerMaxChars: 2000,
};

const MAP_SYSTEM = [
  'You are scanning a meeting transcript one window at a time.',
  'For the CURRENT window only, extract what is relevant to the task as a terse note (one or two sentences), keeping timecodes and speaker names.',
  'Do not summarize the whole meeting — only this window. If nothing in this window is relevant, reply with exactly: NONE',
].join('\n');

const REDUCE_SYSTEM = [
  'You are combining ordered notes taken while scanning a meeting transcript window by window.',
  'Produce a single, well-organized answer to the task. Merge duplicates, keep timecodes and speaker names, and preserve meeting order.',
].join('\n');

/**
 * Sweep the whole transcript in bounded consecutive windows: read a window, jot
 * one note, move to the next — so the full transcript is never resident at
 * once. Notes are then reduced (in tiers if numerous) into a single answer.
 */
export async function runRollingScan(
  model: LanguageModel,
  transcript: Transcript,
  instruction: string,
  options: RollingScanOptions,
  callbacks: RollingScanCallbacks = {},
): Promise<RollingScanResult> {
  const segments = transcript.segments;
  const config = { ...DEFAULTS, ...stripUndefined(options) };
  const overlap = Math.max(0, Math.min(config.overlap, config.windowSize - 1));

  if (segments.length === 0) {
    return {
      answer: `No transcript to scan for: ${instruction}`,
      notes: [],
      windowCount: 0,
    };
  }

  // Enlarge the window (never the count) so a long meeting is fully covered
  // within maxWindows — coarser windows, but nothing skipped.
  const baseStep = Math.max(1, config.windowSize - overlap);
  const step = Math.max(baseStep, Math.ceil(segments.length / config.maxWindows));
  const size = step + overlap;
  const totalWindows = Math.ceil(segments.length / step);

  callbacks.onStart?.(totalWindows);

  const notes: ScanNote[] = [];
  let windowIndex = 0;

  for (let start = 0; start < segments.length; start += step) {
    throwIfAborted(callbacks.signal);

    const end = Math.min(segments.length, start + size);
    const windowSegments = segments.slice(start, end);
    const rendered = renderSegments(windowSegments, start);

    const raw = await model.generate(
      [
        { role: 'system', content: MAP_SYSTEM },
        {
          role: 'user',
          content: `Task: ${instruction}\n\nTranscript window (segments ${start}–${end - 1}):\n${rendered}\n\nNote:`,
        },
      ],
      { maxNewTokens: config.maxNewTokensPerNote, signal: callbacks.signal },
    );

    const note = cleanNote(raw);
    callbacks.onWindow?.(windowIndex, totalWindows, note);

    if (note !== null) {
      const last = windowSegments[windowSegments.length - 1];
      notes.push({
        windowIndex,
        startIndex: start,
        endIndex: end - 1,
        startSeconds: windowSegments[0].startSeconds,
        endSeconds: last.endSeconds,
        note,
      });
    }

    windowIndex += 1;
  }

  const answer = await reduceNotes(model, instruction, notes, config);
  return { answer, notes, windowCount: totalWindows };
}

function renderNote(note: ScanNote): string {
  return `[${formatTimecode(note.startSeconds)}–${formatTimecode(note.endSeconds)}] ${note.note}`;
}

/** Reduce note lines to one answer, tiering when they exceed the char budget. */
async function reduceNotes(
  model: LanguageModel,
  instruction: string,
  notes: ScanNote[],
  config: typeof DEFAULTS,
): Promise<string> {
  if (notes.length === 0) {
    return `Nothing in the meeting was relevant to: ${instruction}`;
  }

  const lines = notes.map(renderNote);
  const answer = await reduceLines(model, instruction, lines, config);
  return capText(answer, config.answerMaxChars);
}

async function reduceLines(
  model: LanguageModel,
  instruction: string,
  lines: string[],
  config: typeof DEFAULTS,
): Promise<string> {
  const chunks = packByCharBudget(lines, config.reduceCharBudget);

  const partials: string[] = [];
  for (const chunk of chunks) {
    const raw = await model.generate(
      [
        { role: 'system', content: REDUCE_SYSTEM },
        {
          role: 'user',
          content: `Task: ${instruction}\n\nNotes (in meeting order):\n${chunk.join('\n')}\n\nAnswer:`,
        },
      ],
      { maxNewTokens: config.maxNewTokensReduce },
    );
    partials.push(raw.trim());
  }

  if (partials.length === 1) {
    return partials[0];
  }

  // Combine partial answers with one more reduction tier.
  return reduceLines(model, instruction, partials, config);
}

/** Greedily pack lines into chunks under a character budget (>= 1 chunk). */
function packByCharBudget(lines: string[], charBudget: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;

  for (const line of lines) {
    if (current.length > 0 && size + line.length > charBudget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [[]];
}

function cleanNote(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || /^none[.!]?$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function capText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trimEnd()}…`;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] !== undefined) {
      result[key] = value[key];
    }
  }
  return result;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Scan was aborted.', 'AbortError');
  }
}
