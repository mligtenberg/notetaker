export interface LiveTranscriptSegment {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export type RecorderStatus = 'idle' | 'ready' | 'recording' | 'saving' | 'error';
export type EngineStatus = 'idle' | 'processing' | 'error';
export type AppPage = 'meetings' | 'settings';
