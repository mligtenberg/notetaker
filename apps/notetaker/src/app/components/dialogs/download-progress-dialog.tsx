import type { DownloadProgressState } from '../../app.types';
import styles from '../../app.module.css';
import { Dialog } from '../common/dialog';

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
    <Dialog
      ariaLabel="Download progress"
      label="Download"
      title={progress.title}
      status={<span>{progress.status}</span>}
      actions={
        progress.status === 'complete' || progress.status === 'error' ? (
          <button type="button" onClick={onClose}>
            Close
          </button>
        ) : null
      }
    >
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
      {progress.status === 'error' && progress.errorMessage ? (
        <p className={styles.message}>{progress.errorMessage}</p>
      ) : null}
    </Dialog>
  );
}
