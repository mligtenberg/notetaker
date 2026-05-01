import type { ChangeEvent } from 'react';
import type { AudioRecordingResult } from '@notetaker/audio-recorder';
import styles from '../app.module.css';

type RecorderStatus = 'idle' | 'ready' | 'recording' | 'saving' | 'error';

interface StoredAudioFile {
  name: string;
  size: number;
  type: string;
  updatedAt: number;
  url: string;
  fileHandle: FileSystemFileHandle;
}

interface RecordingsPageProps {
  status: RecorderStatus;
  message: string;
  files: StoredAudioFile[];
  lastRecording: AudioRecordingResult | null;
  onUploadRecordings: (files: FileList | null) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCancelRecording: () => void;
  onRefreshFiles: () => void;
  onDeleteRecording: (file: StoredAudioFile) => void;
  formatBytes: (size: number) => string;
  formatDate: (timestamp: number) => string;
}

export function RecordingsPage({
  status,
  message,
  files,
  lastRecording,
  onUploadRecordings,
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  onRefreshFiles,
  onDeleteRecording,
  formatBytes,
  formatDate,
}: RecordingsPageProps) {
  const recorderBusy =
    status === 'idle' || status === 'recording' || status === 'saving';

  return (
    <>
      <section className={styles.panel}>
        <div className={styles.listHeader}>
          <div>
            <p className={styles.label}>Recorder</p>
            <h2>Capture audio</h2>
          </div>
          <span data-state={status}>{status}</span>
        </div>
        <p className={styles.message}>{message}</p>

        <label className={styles.uploadBox}>
          <span>Upload recordings</span>
          <strong>
            Import MP3, WAV, M4A, WebM, or OGG files into OPFS/audio-files.
          </strong>
          <input
            type="file"
            accept="audio/*,.mp3,.m4a,.wav,.webm,.ogg"
            multiple
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              onUploadRecordings(event.target.files);
              event.currentTarget.value = '';
            }}
            disabled={recorderBusy}
          />
        </label>

        <div className={styles.actions}>
          <button
            type="button"
            onClick={onStartRecording}
            disabled={status !== 'ready'}
          >
            Start Recording
          </button>
          <button
            type="button"
            onClick={onStopRecording}
            disabled={status !== 'recording'}
          >
            Stop & Save
          </button>
          <button
            type="button"
            onClick={onCancelRecording}
            disabled={status !== 'recording'}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onRefreshFiles}
            disabled={recorderBusy}
          >
            Refresh Files
          </button>
        </div>

        {lastRecording !== null ? (
          <p className={styles.saved}>
            Last saved: <strong>{lastRecording.fileName}</strong> (
            {formatBytes(lastRecording.size)})
          </p>
        ) : null}
      </section>

      <section className={styles.panel}>
        <div className={styles.listHeader}>
          <div>
            <p className={styles.label}>OPFS/audio-files</p>
            <h2>Stored recordings</h2>
          </div>
          <span>
            {files.length} file{files.length === 1 ? '' : 's'}
          </span>
        </div>

        {files.length === 0 ? (
          <p className={styles.empty}>No recordings stored yet.</p>
        ) : (
          <ul className={styles.fileList}>
            {files.map((file) => (
              <li key={`${file.name}-${file.updatedAt}`}>
                <div>
                  <strong>{file.name}</strong>
                  <span>
                    {file.type} | {formatBytes(file.size)} |{' '}
                    {formatDate(file.updatedAt)}
                  </span>
                </div>
                <audio controls src={file.url} />
                <div className={styles.actions}>
                  <button
                    type="button"
                    onClick={() => onDeleteRecording(file)}
                    disabled={recorderBusy}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
