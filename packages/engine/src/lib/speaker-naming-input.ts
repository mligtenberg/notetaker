import type { Meeting } from './models/meeting';
import type { SpeakerTranscriptSegment } from './models/speaker-transcript-segment';

export interface SpeakerNamingInput {
  meeting: Meeting;
  transcript: string;
  segments: Omit<SpeakerTranscriptSegment, 'speakerName'>[];
  speakers: string[];
}
