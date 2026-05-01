import type { Meeting } from './models/meeting';
import type { TranscriptSegment } from './models/transcript-segment';

export interface SpeakerNamingInput {
  meeting: Meeting;
  transcript: string;
  segments: Omit<TranscriptSegment, 'speakerName'>[];
  speakers: string[];
}
