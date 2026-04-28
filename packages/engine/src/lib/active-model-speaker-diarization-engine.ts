import { type ManagedModel, type ModelManager } from '@notetaker/model-manager';
import { requireModelVersion } from './active-model-transcription-engine';
import type { Meeting } from './models/meeting';
import type { SpeakerTurn } from './models/speaker-turn';
import type { SpeakerDiarizationEngine } from './speaker-diarization-engine';

type ModelSelections = Partial<Record<ManagedModel, string>>;

export interface ActiveModelSpeakerDiarizationEngineOptions {
  modelManager: ModelManager;
  selectedModels?: ModelSelections;
}

export class ActiveModelSpeakerDiarizationEngine implements SpeakerDiarizationEngine {
  readonly #modelManager: ModelManager;
  readonly #selectedModels: ModelSelections;

  constructor(options: ActiveModelSpeakerDiarizationEngineOptions) {
    this.#modelManager = options.modelManager;
    this.#selectedModels = options.selectedModels ?? {};
  }

  async diarize(_meeting: Meeting): Promise<SpeakerTurn[]> {
    await requireModelVersion(this.#modelManager, 'pyannote', this.#selectedModels.pyannote);

    return [
      {
        speaker: 'speaker-1',
        startSeconds: 0,
        endSeconds: Number.POSITIVE_INFINITY,
      },
    ];
  }
}
