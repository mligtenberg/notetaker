import type { Meeting } from './meeting';
import type { SpeakerTranscriptSegment } from './speaker-transcript-segment';
import type { SpeakerTurn } from './speaker-turn';
import type { Transcript } from './transcript';

export interface MeetingNotes {
  meeting: Meeting;
  transcript: Transcript;
  speakerTurns: SpeakerTurn[];
  speakerNames: Record<string, string>;
  segments: SpeakerTranscriptSegment[];
}
