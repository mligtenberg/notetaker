import type {
  ManagedModel,
  ModelVersionManifestEntry,
} from '@notetaker/model-manager';
import type {
  DirectModelDownload,
} from '../../services/model-downloads';
import styles from '../../app.module.css';
import {Card} from "../common/card";

interface RepositoryCardProps {
  repositoryId: string;
  repositoryName: string;
  downloads: DirectModelDownload[];
  downloadingModel: ManagedModel | null;
  getKnownDownloadSize: (download: DirectModelDownload) => number;
  getDirectDownloadKey: (download: DirectModelDownload) => string;
  getDirectDownloadVersion: (
    download: DirectModelDownload,
  ) => ModelVersionManifestEntry | undefined;
  onDownloadDirectModel: (download: DirectModelDownload) => void;
  onRemoveModelVersion: (version: ModelVersionManifestEntry) => void;
  activeSection: { downloadingLabel: string; buttonLabel: string };
  formatBytes: (size: number) => string;
}

function getRepositoryUrl(repositoryId: string): string {
  return `https://huggingface.co/${repositoryId}`;
}

function renderScoreStars(score: number): string {
  const fullStars = Math.floor(score);
  const hasHalfStar = score % 1 !== 0;
  const emptyStars = 5 - fullStars - (hasHalfStar ? 1 : 0);

  return `${'★'.repeat(fullStars)}${hasHalfStar ? '½' : ''}${'☆'.repeat(emptyStars)}`;
}

function renderScore(label: string, score: number) {
  return (
    <span className={styles.variantScore} aria-label={`${label}: ${score} of 5`}>
      <span>{label}</span>
      <strong>{renderScoreStars(score)}</strong>
    </span>
  );
}

export function RepositoryCard({
  repositoryId,
  repositoryName,
  downloads,
  downloadingModel,
  getKnownDownloadSize,
  getDirectDownloadKey,
  getDirectDownloadVersion,
  onDownloadDirectModel,
  onRemoveModelVersion,
  activeSection,
  formatBytes,
}: RepositoryCardProps) {
  return (
    <Card className={styles.repositoryCard}>
      <header>
        <strong>{repositoryName}</strong>
        <div className={styles.repositoryMetaLine}>
          <a
            href={getRepositoryUrl(repositoryId)}
            target="_blank"
            rel="noreferrer"
            className={styles.repositoryLink}
          >
            {repositoryId}
          </a>
        </div>
      </header>
      <ul className={styles.variantList}>
        {downloads.map((download) => {
          const downloadedVersion = getDirectDownloadVersion(download);

          return (
            <li key={getDirectDownloadKey(download)}>
              <div className={styles.variantDetails}>
                <div>
                  <strong>{download.quantization ?? download.label}</strong>
                  {downloadedVersion !== undefined ? (
                    <span className={styles.downloadedBadge}>downloaded</span>
                  ) : null}
                </div>
                <p>{download.description}</p>
                <span>{formatBytes(getKnownDownloadSize(download))}</span>
                <div className={styles.variantScores}>
                  {renderScore('Speed', download.scores.speed)}
                  {renderScore('Quality', download.scores.quality)}
                  {renderScore('Size', download.scores.size)}
                </div>
              </div>
              {downloadedVersion !== undefined ? (
                <button
                  type="button"
                  className={styles.dangerButton}
                  onClick={() => onRemoveModelVersion(downloadedVersion)}
                  disabled={downloadingModel !== null}
                >
                  Remove
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onDownloadDirectModel(download)}
                  disabled={downloadingModel !== null}
                >
                  {downloadingModel === download.model
                    ? activeSection.downloadingLabel
                    : activeSection.buttonLabel}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
