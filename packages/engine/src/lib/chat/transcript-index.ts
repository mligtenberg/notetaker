import type { Transcript } from '../models/transcript';
import type { TranscriptSegment } from '../models/transcript-segment';

export interface TranscriptHit {
  index: number;
  speaker: string;
  startSeconds: number;
  text: string;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'that', 'this',
  'de', 'het', 'een', 'en', 'van', 'op', 'in', 'is', 'dat', 'die',
]);

/** Format seconds as m:ss or h:mm:ss. */
export function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function speakerLabel(segment: TranscriptSegment): string {
  return segment.speakerName || segment.speaker || 'Unknown';
}

/**
 * Keyword search over segments. Scores by how many distinct query terms a
 * segment contains, with a bonus for a full-phrase substring match, then breaks
 * ties by transcript order.
 */
export function searchTranscript(
  transcript: Transcript,
  query: string,
  limit = 8,
): TranscriptHit[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return [];
  }

  const terms = normalizedQuery
    .split(/\s+/)
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term));
  const searchTerms = terms.length > 0 ? terms : [normalizedQuery];

  const scored = transcript.segments
    .map((segment, index) => {
      const haystack = segment.text.toLowerCase();
      let score = 0;
      for (const term of searchTerms) {
        if (haystack.includes(term)) {
          score += 1;
        }
      }
      if (haystack.includes(normalizedQuery)) {
        score += searchTerms.length;
      }
      return { index, segment, score };
    })
    .filter((entry) => entry.score > 0);

  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  return scored.slice(0, limit).map(({ index, segment }) => ({
    index,
    speaker: speakerLabel(segment),
    startSeconds: segment.startSeconds,
    text: segment.text,
  }));
}

export interface ReadWindowOptions {
  fromIndex?: number;
  toIndex?: number;
  fromSeconds?: number;
  toSeconds?: number;
  maxSegments?: number;
}

export interface ReadWindowResult {
  startIndex: number;
  segments: TranscriptSegment[];
}

/** Return a bounded window of segments by index or by time range. */
export function readTranscriptWindow(
  transcript: Transcript,
  options: ReadWindowOptions,
): ReadWindowResult {
  const { segments } = transcript;
  const maxSegments = options.maxSegments ?? 40;
  let start = 0;
  let end = segments.length;

  if (options.fromIndex !== undefined || options.toIndex !== undefined) {
    start = Math.max(0, options.fromIndex ?? 0);
    end = Math.min(segments.length, (options.toIndex ?? segments.length - 1) + 1);
  } else if (
    options.fromSeconds !== undefined ||
    options.toSeconds !== undefined
  ) {
    const from = options.fromSeconds ?? 0;
    const to = options.toSeconds ?? Number.POSITIVE_INFINITY;
    const first = segments.findIndex((s) => s.endSeconds >= from);
    start = first === -1 ? segments.length : first;
    let last = start;
    while (last < segments.length && segments[last].startSeconds <= to) {
      last += 1;
    }
    end = last;
  }

  return {
    startIndex: start,
    segments: segments.slice(start, Math.min(end, start + maxSegments)),
  };
}

/** Compact, model-facing rendering of search hits. */
export function renderHits(hits: TranscriptHit[]): string {
  if (hits.length === 0) {
    return 'No matching segments found.';
  }

  return hits
    .map(
      (hit) =>
        `#${hit.index} [${formatTimecode(hit.startSeconds)}] ${hit.speaker}: ${hit.text}`,
    )
    .join('\n');
}

/** Compact, model-facing rendering of a window of segments. */
export function renderSegments(
  segments: TranscriptSegment[],
  startIndex: number,
): string {
  if (segments.length === 0) {
    return 'No segments in that range.';
  }

  return segments
    .map(
      (segment, offset) =>
        `#${startIndex + offset} [${formatTimecode(segment.startSeconds)}] ${speakerLabel(segment)}: ${segment.text}`,
    )
    .join('\n');
}

/** Human-readable status line the assistant can rely on. */
export function describeMeeting(
  transcript: Transcript | null,
  status: 'none' | 'draft' | 'finalized',
  title: string,
): string {
  if (transcript === null || transcript.segments.length === 0) {
    return `Meeting "${title}". Transcript status: ${status}. No transcript segments are available yet.`;
  }

  const speakers = [
    ...new Set(transcript.segments.map((s) => speakerLabel(s))),
  ];
  const lastSegment = transcript.segments[transcript.segments.length - 1];
  const durationLabel = formatTimecode(lastSegment.endSeconds);

  return [
    `Meeting "${title}".`,
    `Transcript status: ${status}${status === 'draft' ? ' (still being recorded — may be incomplete)' : ''}.`,
    `${transcript.segments.length} segments, ~${durationLabel} long.`,
    `Language: ${transcript.language ?? 'unknown'}.`,
    `Speakers: ${speakers.join(', ')}.`,
    'Segment indices run from 0. Use search_transcript to locate topics, then read_transcript to read around a hit.',
  ].join(' ');
}
