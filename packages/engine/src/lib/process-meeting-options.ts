import type { EngineProgressEvent } from './engine-progress-event';
import { TimestampedText } from './models/timestamped-text';

export interface ProcessMeetingOptions {
  onProgress?: (event: EngineProgressEvent) => void;
  onDebug?: (line: string) => void;
  onPartialTranscript?: (fragments: TimestampedText[]) => void;
  speakerCountHint?: number | null;
}
