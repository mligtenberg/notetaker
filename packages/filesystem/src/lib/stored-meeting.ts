export type MeetingDerivationKind =
  | 'transcript'
  | 'diarization'
  | 'word-sync'
  | 'speaker-names';

export type LanguageMode = 'auto-once' | 'auto-per-chunk' | 'translate';

export interface StoredMeeting {
  id: string;
  name: string;
  date: string;
  participantCount: number;
  recordingFileName: string | null;
  recordingMimeType: string | null;
  recordingSize: number | null;
  createdAt: number;
  languageMode?: LanguageMode;
}

export interface StoredMeetingSummary extends StoredMeeting {
  derivations: Record<MeetingDerivationKind, boolean>;
}
