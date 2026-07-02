import type { ChangeEvent } from 'react';
import type { LanguageMode, StoredMeetingSummary } from '@notetaker/filesystem';
import styles from '../../../app.module.css';
import { RecordingMedia } from './shared';
import type { MediaElementRef, RecorderStatus } from './types';

interface RecordingTabProps {
  meeting: StoredMeetingSummary;
  meetingUrl: string | undefined;
  audioRef: MediaElementRef;
  isRecording: boolean;
  status: RecorderStatus;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCancelRecording: () => void;
  onUploadRecording: (file: File) => void;
  onChangeLanguageMode: (mode: LanguageMode) => void;
  formatBytes: (size: number) => string;
}

const LANGUAGE_MODE_OPTIONS: { value: LanguageMode; label: string }[] = [
  { value: 'auto-once', label: 'Auto-detect once (recommended)' },
  { value: 'auto-per-chunk', label: 'Auto-detect per chunk (experimental)' },
  { value: 'translate', label: 'Translate to English' },
];

export function RecordingTab({
  meeting,
  meetingUrl,
  audioRef,
  isRecording,
  status,
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  onUploadRecording,
  onChangeLanguageMode,
  formatBytes,
}: RecordingTabProps) {
  const hasRecording = meeting.recordingFileName !== null;
  const languageMode: LanguageMode = meeting.languageMode ?? 'auto-once';

  function handleUpload(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.currentTarget.value = '';

    if (file !== undefined) {
      onUploadRecording(file);
    }
  }

  return (
    <>
      {hasRecording && meetingUrl !== undefined ? (
        <div className={styles.recordingPlayback}>
          <RecordingMedia
            mediaRef={audioRef}
            meetingUrl={meetingUrl}
            mimeType={meeting.recordingMimeType}
          />
        </div>
      ) : (
        <p className={styles.empty}>No recording attached yet.</p>
      )}

      {hasRecording && meeting.recordingSize !== null ? (
        <p className={styles.message}>
          {formatBytes(meeting.recordingSize)}
          {meeting.recordingMimeType !== null
            ? ` | ${meeting.recordingMimeType}`
            : ''}
        </p>
      ) : null}

      <div className={styles.actions}>
        {isRecording ? (
          <>
            <button type="button" onClick={onStopRecording}>
              Stop & Save
            </button>
            <button type="button" onClick={onCancelRecording}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onStartRecording}
              disabled={status === 'saving'}
            >
              {hasRecording ? 'Re-record' : 'Start Recording'}
            </button>
            <label className={styles.uploadInline}>
              <span>
                {hasRecording ? 'Replace via upload' : 'Upload audio/video'}
              </span>
              <input
                type="file"
                accept="audio/*,video/*,.mp3,.m4a,.wav,.webm,.ogg,.mp4,.mov,.m4v"
                onChange={handleUpload}
                disabled={status === 'saving'}
              />
            </label>
          </>
        )}
      </div>

      <label className={styles.uploadInline}>
        <span>Language handling</span>
        <select
          value={languageMode}
          onChange={(event) =>
            onChangeLanguageMode(event.target.value as LanguageMode)
          }
          disabled={isRecording || status === 'saving'}
        >
          {LANGUAGE_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
