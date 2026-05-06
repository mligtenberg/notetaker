import { useMemo, useState } from 'react';
import type { ManagedModel } from '@notetaker/model-manager';
import styles from '../../app.module.css';
import {
  MODEL_DOWNLOAD_TARGETS,
  getKnownDownloadSize,
  getRecommendedDownload,
  type DirectModelDownload,
} from '../../services/model-downloads';
import { Dialog } from '../common/dialog';

interface SetupWizardDialogProps {
  isDownloading: boolean;
  formatBytes: (size: number) => string;
  onDownload: (downloads: DirectModelDownload[]) => void;
  onSkip: () => void;
}

interface RecommendedEntry {
  model: ManagedModel;
  label: string;
  description: string;
  download: DirectModelDownload | undefined;
}

export function SetupWizardDialog({
  isDownloading,
  formatBytes,
  onDownload,
  onSkip,
}: SetupWizardDialogProps) {
  const entries = useMemo<RecommendedEntry[]>(
    () =>
      MODEL_DOWNLOAD_TARGETS.map((target) => ({
        model: target.model,
        label: target.label,
        description: target.description,
        download: getRecommendedDownload(target.model),
      })),
    [],
  );

  const [selected, setSelected] = useState<Set<ManagedModel>>(
    () => new Set(entries.filter((entry) => entry.download).map((entry) => entry.model)),
  );

  const totalBytes = entries.reduce(
    (total, entry) =>
      entry.download !== undefined && selected.has(entry.model)
        ? total + getKnownDownloadSize(entry.download)
        : total,
    0,
  );

  function toggle(model: ManagedModel) {
    setSelected((current) => {
      const next = new Set(current);

      if (next.has(model)) {
        next.delete(model);
      } else {
        next.add(model);
      }

      return next;
    });
  }

  function handleDownload() {
    const downloads = entries
      .filter((entry) => entry.download !== undefined && selected.has(entry.model))
      .map((entry) => entry.download as DirectModelDownload);

    onDownload(downloads);
  }

  return (
    <Dialog
      ariaLabel="Setup wizard"
      label="Welcome"
      title="Get started with Notetaker"
      actions={
        <div className={styles.dialogActions}>
          <button
            type="button"
            className={styles.textButton}
            onClick={onSkip}
            disabled={isDownloading}
          >
            Skip for now
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={isDownloading || selected.size === 0}
          >
            {isDownloading
              ? 'Downloading...'
              : `Download ${selected.size} model${selected.size === 1 ? '' : 's'} (${formatBytes(totalBytes)})`}
          </button>
        </div>
      }
    >
      <p className={styles.message}>
        Notetaker runs locally and needs a few models to transcribe, diarize, and label
        meetings. We&apos;ve picked a balanced default for each. Uncheck anything you
        don&apos;t want yet — you can change selections later in Settings.
      </p>

      <ul className={styles.modelVersionList}>
        {entries.map((entry) => {
          const checked = selected.has(entry.model);
          const sizeLabel =
            entry.download !== undefined
              ? formatBytes(getKnownDownloadSize(entry.download))
              : 'unavailable';

          return (
            <li key={entry.model}>
              <label
                style={{
                  display: 'grid',
                  gap: '0.35rem',
                  gridTemplateColumns: 'auto minmax(0, 1fr)',
                  alignItems: 'start',
                  cursor: entry.download ? 'pointer' : 'not-allowed',
                  margin: 0,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isDownloading || entry.download === undefined}
                  onChange={() => toggle(entry.model)}
                  style={{ marginTop: '0.2rem' }}
                />
                <span>
                  <strong>{entry.label}</strong>
                  <span>
                    {entry.download
                      ? `${entry.download.label} · ${sizeLabel}`
                      : 'No recommended preset'}
                  </span>
                  <span style={{ color: '#7d9aa8', marginTop: '0.25rem' }}>
                    {entry.description}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
