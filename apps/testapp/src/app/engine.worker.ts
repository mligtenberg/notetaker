/// <reference lib="webworker" />
import { Engine } from '../../../../packages/engine/src/lib/engine';
import { PipelineFactory } from '../../../../packages/engine/src/lib/pipeline-factory';
import { configureTransformersCache } from '../../../../packages/engine/src/lib/transformers-cache';
import type { EngineProgressEvent } from '../../../../packages/engine/src/lib/engine-progress-event';
import type { MeetingNotes } from '../../../../packages/engine/src/lib/models/meeting-notes';
import type { SpeakerTurn } from '../../../../packages/engine/src/lib/models/speaker-turn';
import type { Transcript } from '../../../../packages/engine/src/lib/models/transcript';
import { FileSystem } from '@notetaker/filesystem';
import { ModelManager } from '@notetaker/model-manager';

interface WorkerTranscriptSegment {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

interface TimestampedText {
  timestampInMs: number;
  text: string;
}

let currentLogger: ((line: string) => void) | null = null;

function log(line: string): void {
  currentLogger?.(line);
}

function estimateFragmentEndSeconds(
  startSeconds: number,
  text: string,
): number {
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  return startSeconds + Math.max(1, wordCount * 0.45);
}

function findSpeakerForRange(
  startSeconds: number,
  endSeconds: number,
  turns: SpeakerTurn[],
): string {
  let bestTurn: SpeakerTurn | undefined;
  let bestOverlap = 0;

  for (const turn of turns) {
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

function toWorkerTranscriptSegments(
  fragments: TimestampedText[],
): WorkerTranscriptSegment[] {
  return fragments.map((fragment, index) => {
    const nextFragment = fragments[index + 1];
    const startSeconds = fragment.timestampInMs / 1000;

    return {
      text: fragment.text,
      startSeconds,
      endSeconds:
        nextFragment?.timestampInMs !== undefined
          ? nextFragment.timestampInMs / 1000
          : estimateFragmentEndSeconds(startSeconds, fragment.text),
    };
  });
}

function anchorWordsToTranscriptSegments(
  words: TimestampedWord[],
  transcript: Transcript,
): TimestampedWord[] {
  let wordIndex = 0;
  const anchoredWords: TimestampedWord[] = [];

  for (const segment of transcript.segments) {
    const segmentWords = segment.text.match(/\S+/g) ?? [];

    if (segmentWords.length === 0) {
      continue;
    }

    const startSeconds = segment.startSeconds;
    const endSeconds = Math.max(
      segment.endSeconds,
      startSeconds + segmentWords.length * 0.25,
    );
    const stepSeconds =
      segmentWords.length === 1
        ? 0
        : (endSeconds - startSeconds) / segmentWords.length;

    for (let index = 0; index < segmentWords.length; index += 1) {
      const word = words[wordIndex];
      const alignedSeconds = (word?.timestampInMs ?? -1) / 1000;
      const interpolatedSeconds = startSeconds + index * stepSeconds;
      const timestampInMs =
        alignedSeconds >= startSeconds - 1 && alignedSeconds <= endSeconds + 1
          ? Math.round(alignedSeconds * 1000)
          : Math.round(interpolatedSeconds * 1000);

      anchoredWords.push({
        word: word?.word ?? segmentWords[index],
        timestampInMs,
      });
      wordIndex += 1;
    }
  }

  return anchoredWords;
}

export interface TimestampedWord {
  word: string;
  timestampInMs: number;
}

export interface EngineWorkerRequest {
  id: number;
  mode?:
    | 'engine'
    | 'transcription'
    | 'diarization'
    | 'word-sync'
    | 'speaker-naming';
  fileName: string;
  audio: Float32Array;
  audioSampleRate?: number;
  useWebGpu?: boolean;
  numSpeakers?: number | null;
  transcript?: Transcript;
  diarization?: SpeakerTurn[];
}

export type EngineWorkerResponse =
  | { id: number; type: 'progress'; event: EngineProgressEvent }
  | { id: number; type: 'log'; line: string }
  | { id: number; type: 'bar'; value: number | null }
  | {
      id: number;
      type: 'live-transcript';
      text: string;
      segments: WorkerTranscriptSegment[];
    }
  | {
      id: number;
      type: 'result';
      ok: true;
      mode: 'engine';
      notes: MeetingNotes;
    }
  | {
      id: number;
      type: 'result';
      ok: true;
      mode: 'transcription';
      transcript: Transcript;
    }
  | {
      id: number;
      type: 'result';
      ok: true;
      mode: 'diarization';
      turns: SpeakerTurn[];
    }
  | {
      id: number;
      type: 'result';
      ok: true;
      mode: 'word-sync';
      words: TimestampedWord[];
    }
  | {
      id: number;
      type: 'result';
      ok: true;
      mode: 'speaker-naming';
      names: Record<string, string>;
    }
  | { id: number; type: 'result'; ok: false; error: string };

let modelManagerPromise: Promise<ModelManager> | null = null;

console.log('[engine-worker] module initialized');
function getModelManager(): Promise<ModelManager> {
  if (modelManagerPromise === null) {
    modelManagerPromise = ModelManager.create(new FileSystem());
  }

  return modelManagerPromise;
}

self.addEventListener('message', (event: MessageEvent<EngineWorkerRequest>) => {
  console.log('[engine-worker] message received', event);
  const {
    id,
    mode = 'engine',
    fileName,
    audio,
    numSpeakers = null,
  } = event.data;

  void (async () => {
    currentLogger = (line) => {
      const message: EngineWorkerResponse = { id, type: 'log', line };
      (self as DedicatedWorkerGlobalScope).postMessage(message);
    };
    try {
      const modelManager = await getModelManager();
      configureTransformersCache(modelManager);
      log(
        `[runtime] crossOriginIsolated=${globalThis.crossOriginIsolated}; hardwareConcurrency=${navigator.hardwareConcurrency ?? 'unknown'}`,
      );
      const engine = new Engine(new PipelineFactory(), modelManager);

      if (mode === 'transcription') {
        const fragments: TimestampedText[] = [];
        const progress: EngineWorkerResponse = {
          id,
          type: 'progress',
          event: { stage: 'transcription', status: 'started' },
        };
        (self as DedicatedWorkerGlobalScope).postMessage(progress);
        log(
          `[transcription] worker received ${audio.length} samples for ${fileName}.`,
        );
        const transcriptText = await engine.transcribeAudio(
          audio,
          (updates) => {
            log(
              `[transcription] worker received ${updates.length} fragment update(s).`,
            );
            fragments.splice(0, fragments.length, ...updates);
            const segments = toWorkerTranscriptSegments(fragments);
            const message: EngineWorkerResponse = {
              id,
              type: 'live-transcript',
              text: fragments.map((fragment) => fragment.text).join(' '),
              segments,
            };
            (self as DedicatedWorkerGlobalScope).postMessage(message);
          },
          log,
        );
        log(
          `[transcription] worker completed with transcript length=${transcriptText.length}; fragments=${fragments.length}.`,
        );
        const completed: EngineWorkerResponse = {
          id,
          type: 'progress',
          event: { stage: 'transcription', status: 'completed' },
        };
        (self as DedicatedWorkerGlobalScope).postMessage(completed);
        const response: EngineWorkerResponse = {
          id,
          type: 'result',
          ok: true,
          mode: 'transcription',
          transcript: {
            text: transcriptText,
            segments: toWorkerTranscriptSegments(fragments).map((segment) => ({
              ...segment,
              speaker: 'SPEAKER_0',
              speakerName: 'SPEAKER_0',
            })),
          },
        };
        (self as DedicatedWorkerGlobalScope).postMessage(response);
        return;
      }

      if (mode === 'word-sync') {
        const transcript = event.data.transcript;
        if (transcript === undefined) {
          throw new Error('word-sync requires a transcript.');
        }
        const progress: EngineWorkerResponse = {
          id,
          type: 'progress',
          event: { stage: 'word-sync', status: 'started' },
        };
        (self as DedicatedWorkerGlobalScope).postMessage(progress);
        const words = await engine.alignTranscriptToAudio(
          transcript.text,
          audio,
          log,
          event.data.audioSampleRate,
        );
        const anchoredWords = anchorWordsToTranscriptSegments(
          words,
          transcript,
        );
        log(
          `[word-sync] anchored ${anchoredWords.length} word timestamp(s) to ${transcript.segments.length} transcript segment(s).`,
        );
        const completed: EngineWorkerResponse = {
          id,
          type: 'progress',
          event: { stage: 'word-sync', status: 'completed' },
        };
        (self as DedicatedWorkerGlobalScope).postMessage(completed);
        const response: EngineWorkerResponse = {
          id,
          type: 'result',
          ok: true,
          mode: 'word-sync',
          words: anchoredWords.map((w) => ({
            word: w.word,
            timestampInMs: w.timestampInMs,
          })),
        };
        (self as DedicatedWorkerGlobalScope).postMessage(response);
        return;
      }

      if (mode === 'speaker-naming') {
        const transcript = event.data.transcript;
        const turns = event.data.diarization;
        if (transcript === undefined || turns === undefined) {
          throw new Error(
            'speaker-naming requires a transcript and diarization.',
          );
        }
        const progress: EngineWorkerResponse = {
          id,
          type: 'progress',
          event: { stage: 'speaker-naming', status: 'started' },
        };
        (self as DedicatedWorkerGlobalScope).postMessage(progress);

        const segments = transcript.segments.map((segment) => ({
          text: segment.text,
          startSeconds: segment.startSeconds,
          endSeconds: segment.endSeconds,
          speaker: findSpeakerForRange(
            segment.startSeconds,
            segment.endSeconds,
            turns,
          ),
        }));

        const namesMap = await engine.nameSpeakers(
          { id: fileName, title: fileName, audio },
          segments,
        );

        const completed: EngineWorkerResponse = {
          id,
          type: 'progress',
          event: { stage: 'speaker-naming', status: 'completed' },
        };
        (self as DedicatedWorkerGlobalScope).postMessage(completed);
        const response: EngineWorkerResponse = {
          id,
          type: 'result',
          ok: true,
          mode: 'speaker-naming',
          names: Object.fromEntries(namesMap),
        };
        (self as DedicatedWorkerGlobalScope).postMessage(response);
        return;
      }

      if (mode === 'diarization') {
        const progress: EngineWorkerResponse = {
          id,
          type: 'progress',
          event: { stage: 'diarization', status: 'started' },
        };
        (self as DedicatedWorkerGlobalScope).postMessage(progress);
        const turns = await engine.diarizeAudio(audio, {
          speakerCountHint: numSpeakers,
          debug: log,
        });
        const completed: EngineWorkerResponse = {
          id,
          type: 'progress',
          event: { stage: 'diarization', status: 'completed' },
        };
        (self as DedicatedWorkerGlobalScope).postMessage(completed);
        const response: EngineWorkerResponse = {
          id,
          type: 'result',
          ok: true,
          mode: 'diarization',
          turns,
        };
        (self as DedicatedWorkerGlobalScope).postMessage(response);
        return;
      }

      const notes = await engine.processMeeting(
        {
          id: fileName,
          title: fileName,
          audio,
        },
        {
          onProgress: (event) => {
            const progress: EngineWorkerResponse = {
              id,
              type: 'progress',
              event,
            };
            (self as DedicatedWorkerGlobalScope).postMessage(progress);
          },
          onDebug: log,
          onPartialTranscript: (fragments) => {
            log(
              `[transcription] worker received ${fragments.length} partial fragment update(s).`,
            );
            const segments = toWorkerTranscriptSegments(fragments);
            const message: EngineWorkerResponse = {
              id,
              type: 'live-transcript',
              text: fragments.map((fragment) => fragment.text).join(' '),
              segments,
            };
            (self as DedicatedWorkerGlobalScope).postMessage(message);
          },
          speakerCountHint: numSpeakers,
        },
      );
      const sanitized: MeetingNotes = {
        ...notes,
        meeting: { ...notes.meeting, audio: new Uint8Array(0) },
      };
      const response: EngineWorkerResponse = {
        id,
        type: 'result',
        ok: true,
        mode: 'engine',
        notes: sanitized,
      };
      (self as DedicatedWorkerGlobalScope).postMessage(response);
    } catch (error) {
      const response: EngineWorkerResponse = {
        id,
        type: 'result',
        ok: false,
        error:
          error instanceof Error ? error.message : 'Engine processing failed.',
      };
      (self as DedicatedWorkerGlobalScope).postMessage(response);
    } finally {
      currentLogger = null;
    }
  })();
});
