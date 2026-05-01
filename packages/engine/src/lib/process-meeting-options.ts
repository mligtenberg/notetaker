import type { EngineProgressEvent } from './engine-progress-event';

export interface ProcessMeetingOptions {
  onProgress?: (event: EngineProgressEvent) => void;
  onDebug?: (line: string) => void;
}
