import type { TranscriptSegment } from './transcript-segment';

export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
}
