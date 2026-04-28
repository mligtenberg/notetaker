import type { SpeakerNameGuess } from './speaker-name-guess';
import type { SpeakerNamingInput } from './speaker-naming-input';

export interface SpeakerNamingModel {
  nameSpeakers(input: SpeakerNamingInput): Promise<SpeakerNameGuess[]>;
}
