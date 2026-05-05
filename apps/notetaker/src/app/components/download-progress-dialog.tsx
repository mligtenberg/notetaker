import type { DownloadProgressState } from '../app.types';
import styles from '../app.module.css';

interface DownloadProgressDialogProps {
  progress: DownloadProgressState;
  percent: number | null;
  formatBytes: (size: number) => string;
  onClose: () => void;
}

export function DownloadProgressDialog({
  progress,
  percent,
  formatBytes,
  onClose,
}: DownloadProgressDialogProps) {
  return (
    <div
      className={styles.downloadOverlay}
      role="dialog"
      aria-modal="true"
      aria-label="Download progress"
    >
      <section className={styles.downloadDialog}>
        <div className={styles.listHeader}>
          <div>
            <p className={styles.label}>Download</p>
            <h2>{progress.title}</h2>
          </div>
          <span>{progress.status}</span>
        </div>
        <p className={styles.message}>
          File {progress.fileIndex} of {progress.fileCount}: {progress.currentFile}
        </p>
        <div className={styles.progressTrack}>
          <div style={{ width: `${percent ?? 8}%` }} />
        </div>
        <p className={styles.progressMeta}>
          {formatBytes(progress.loadedBytes)} /{' '}
          {progress.totalBytes === null
            ? 'unknown'
            : formatBytes(progress.totalBytes)}
          {percent === null ? '' : ` (${percent}%)`}
        </p>
        {progress.status === 'complete' || progress.status === 'error' ? (
          <button type="button" onClick={onClose}>
            Close
          </button>
        ) : null}
      </section>
    </div>
  );
}
