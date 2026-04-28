import type { MeetingAudio } from './meeting-audio';

export interface Meeting {
  audio: MeetingAudio;
  id?: string;
  title?: string;
  startedAt?: Date;
  metadata?: Record<string, unknown>;
}
