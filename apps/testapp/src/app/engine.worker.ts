/// <reference lib="webworker" />
import {
  Engine,
  type EngineProgressEvent,
  type MeetingNotes,
  PipelineFactory,
  type SpeakerTurn,
  type Transcript,
} from '@notetaker/engine';
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

function estimateFragmentEndSeconds(startSeconds: number, text: string): number {
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  return startSeconds + Math.max(1, wordCount * 0.45);
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

export interface EngineWorkerRequest {
  id: number;
  mode?: 'engine' | 'transcription' | 'diarization';
  fileName: string;
  audio: Float32Array;
  useWebGpu?: boolean;
  numSpeakers?: number | null;
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
  | { id: number; type: 'result'; ok: false; error: string };

let modelManagerPromise: Promise<ModelManager> | null = null;

function getModelManager(): Promise<ModelManager> {
  if (modelManagerPromise === null) {
    modelManagerPromise = ModelManager.create(new FileSystem());
  }

  return modelManagerPromise;
}

self.addEventListener('message', (event: MessageEvent<EngineWorkerRequest>) => {
  const {
    id,
    mode = 'engine',
    fileName,
    audio,
  } = event.data;

  void (async () => {
    currentLogger = (line) => {
      const message: EngineWorkerResponse = { id, type: 'log', line };
      (self as DedicatedWorkerGlobalScope).postMessage(message);
    };
    try {
      const modelManager = await getModelManager();
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
            fragments.push(...updates);
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

      if (mode === 'diarization') {
        const progress: EngineWorkerResponse = {
          id,
          type: 'progress',
          event: { stage: 'diarization', status: 'started' },
        };
        (self as DedicatedWorkerGlobalScope).postMessage(progress);
        const turns = await engine.diarizeAudio(audio);
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
