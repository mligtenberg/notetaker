import type { Meeting } from './models/meeting';
import type { SpeakerTurn } from './models/speaker-turn';

export interface SpeakerDiarizationEngine {
  diarize(meeting: Meeting): Promise<SpeakerTurn[]>;
}
