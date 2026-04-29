/// <reference lib="webworker" />
import {
  ActiveModelSpeakerDiarizationEngine,
  ActiveModelTranscriptionEngine,
  Engine,
  type EngineProgressEvent,
  type MeetingNotes,
  type SpeakerNameGuess,
  type SpeakerNamingInput,
  type SpeakerNamingModel,
  type SpeakerTurn,
  type Transcript,
} from '@notetaker/engine';
import { FileSystem } from '@notetaker/filesystem';
import {
  ModelManager,
  type ManagedModel,
  type ModelVersionManifestEntry,
} from '@notetaker/model-manager';

type WorkerModelSelections = Partial<Record<ManagedModel, string>>;
type WhisperDtype = 'q8' | 'fp32';

interface WorkerTranscriptSegment {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

let currentLogger: ((line: string) => void) | null = null;
let currentBarEmitter: ((value: number | null) => void) | null = null;

function log(line: string): void {
  currentLogger?.(line);
}

function emitBar(value: number | null): void {
  currentBarEmitter?.(value);
}

class ActiveModelSpeakerNamingModel implements SpeakerNamingModel {
  readonly #modelManager: ModelManager;
  readonly #selectedModels: WorkerModelSelections;

  constructor(
    modelManager: ModelManager,
    selectedModels: WorkerModelSelections,
  ) {
    this.#modelManager = modelManager;
    this.#selectedModels = selectedModels;
  }

  async nameSpeakers(_input: SpeakerNamingInput): Promise<SpeakerNameGuess[]> {
    await requireModelVersion(
      this.#modelManager,
      'gemma4',
      this.#selectedModels.gemma4,
    );

    return [];
  }
}

async function requireModelVersion(
  modelManager: ModelManager,
  model: ManagedModel,
  selectedVersion?: string,
): Promise<ModelVersionManifestEntry> {
  if (selectedVersion !== undefined && selectedVersion.length > 0) {
    const selectedModel = await modelManager.getVersion(model, selectedVersion);

    if (selectedModel === null) {
      throw new Error(
        `Selected ${model} model ${selectedVersion} is not available.`,
      );
    }

    return selectedModel.manifest;
  }

  const activeModel = await modelManager.getActiveVersion(model);

  if (activeModel === null) {
    throw new Error(`Download and activate a ${model} model first.`);
  }

  return activeModel.manifest;
}

export interface EngineWorkerRequest {
  id: number;
  mode?: 'engine' | 'transcription' | 'diarization';
  fileName: string;
  audio: Float32Array;
  selectedModels?: WorkerModelSelections;
  useWebGpu?: boolean;
  whisperDtype?: WhisperDtype;
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
    selectedModels = {},
    useWebGpu = false,
    whisperDtype = 'q8',
    numSpeakers = null,
  } = event.data;


  void (async () => {
    currentLogger = (line) => {
      const message: EngineWorkerResponse = { id, type: 'log', line };
      (self as DedicatedWorkerGlobalScope).postMessage(message);
    };
    currentBarEmitter = (value) => {
      const message: EngineWorkerResponse = { id, type: 'bar', value };
      (self as DedicatedWorkerGlobalScope).postMessage(message);
    };

    try {
      const modelManager = await getModelManager();
      log(
        `[runtime] crossOriginIsolated=${globalThis.crossOriginIsolated}; hardwareConcurrency=${navigator.hardwareConcurrency ?? 'unknown'}`,
      );
      const transcription = new ActiveModelTranscriptionEngine({
        modelManager,
        selectedModels,
        preferWebGpu: useWebGpu,
        whisperDtype,
        onLog: log,
        onProgress: emitBar,
        onTranscriptUpdate: (update) => {
          const message: EngineWorkerResponse = {
            id,
            type: 'live-transcript',
            text: update.text,
            segments: update.segments,
          };
          (self as DedicatedWorkerGlobalScope).postMessage(message);
        },
      });

      if (mode === 'transcription') {
        const progress: EngineWorkerResponse = {
          id,
          type: 'progress',
          event: { stage: 'transcription', status: 'started' },
        };
        (self as DedicatedWorkerGlobalScope).postMessage(progress);
        const transcript = await transcription.transcribe({
          id: fileName,
          title: fileName,
          audio,
        });
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
          transcript,
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
        const diarization = new ActiveModelSpeakerDiarizationEngine({
          modelManager,
          selectedModels,
          numSpeakers,
          onLog: log,
          onProgress: emitBar,
        });
        const turns = await diarization.diarize({
          id: fileName,
          title: fileName,
          audio,
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

      const engine = new Engine({
        transcription,
        diarization: new ActiveModelSpeakerDiarizationEngine({
          modelManager,
          selectedModels,
        }),
        speakerNaming: new ActiveModelSpeakerNamingModel(
          modelManager,
          selectedModels,
        ),
      });
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
      currentBarEmitter = null;
    }
  })();
});
