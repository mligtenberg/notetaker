export type RecorderStatus = 'idle' | 'ready' | 'recording' | 'saving' | 'error';
export type EngineStatus = 'idle' | 'processing' | 'error';
export type MediaElementRef = { current: HTMLMediaElement | null };

export interface TimestampedWord {
  word: string;
  timestampInMs: number;
  endTimeInMs: number;
}

export interface SpeakerWordTurn {
  speaker: string;
  startSeconds: number;
  endSeconds: number;
  words: TimestampedWord[];
  wordCount: number;
}

export interface SpeakerContextMenuState {
  sourceSpeaker: string;
  turnIndex?: number;
  x: number;
  y: number;
}

export type SpeakerContextMenuMode = 'menu' | 'rename' | 'merge' | 'edit';

export interface LiveTranscriptSegment {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface WordAssignmentPopoverState {
  turnIndex: number;
  wordIndex: number;
  wordTimestampInMs: number;
  x: number;
  y: number;
}

export interface TranscriptSegmentMenuState {
  segmentIndex: number;
  x: number;
  y: number;
}
