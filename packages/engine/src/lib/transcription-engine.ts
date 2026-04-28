import type { Meeting } from './models/meeting';
import type { Transcript } from './models/transcript';

export interface TranscriptionEngine {
  transcribe(meeting: Meeting, options?: {
    newline_callback?: (timeCode: string, line: string) => void
  }): Promise<Transcript>;
}
