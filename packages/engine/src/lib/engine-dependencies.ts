import type { SpeakerDiarizationEngine } from './speaker-diarization-engine';
import type { SpeakerNamingModel } from './speaker-naming-model';
import type { TranscriptionEngine } from './transcription-engine';

export interface EngineDependencies {
  transcription: TranscriptionEngine;
  diarization: SpeakerDiarizationEngine;
  speakerNaming: SpeakerNamingModel;
}
