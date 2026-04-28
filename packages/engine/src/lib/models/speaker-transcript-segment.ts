import type { TranscriptSegment } from './transcript-segment';

export interface SpeakerTranscriptSegment extends TranscriptSegment {
  speaker: string;
  speakerName: string;
}
