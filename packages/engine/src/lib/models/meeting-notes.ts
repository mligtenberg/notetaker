import type { Meeting } from './meeting';
import type { Transcript } from './transcript';

export interface MeetingNotes {
  meeting: Meeting;
  transcript: Transcript;
}
