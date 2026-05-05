import type {
  ManagedModel,
  ModelVersionManifestEntry,
} from '@notetaker/model-manager';
import type {
  DirectModelDownload,
  DownloadSection,
  ModelDownloadTarget,
} from '../services/model-downloads';
import styles from '../app.module.css';
import { Page } from './page';

interface RepositoryDownloadGroup {
  id: string;
  name: string;
  downloads: DirectModelDownload[];
}

function getRepositoryUrl(repositoryId: string): string {
  return `https://huggingface.co/${repositoryId}`;
}

interface ModelsPageProps {
  modelVersions: ModelVersionManifestEntry[];
  modelMessage: string;
  downloadingModel: ManagedModel | null;
  modelTargets: ModelDownloadTarget[];
  downloadSections: DownloadSection[];
  getKnownDownloadSize: (download: DirectModelDownload) => number;
  getDirectDownloadKey: (download: DirectModelDownload) => string;
  getDirectDownloadVersion: (
    download: DirectModelDownload,
  ) => ModelVersionManifestEntry | undefined;
  getModelVersions: (model: ManagedModel) => ModelVersionManifestEntry[];
  getModelVersionTitle: (version: ModelVersionManifestEntry) => string;
  onDownloadDirectModel: (download: DirectModelDownload) => void;
  onSetActiveModelVersion: (model: ManagedModel, version: string) => void;
  onRemoveModelVersion: (version: ModelVersionManifestEntry) => void;
  activeModel: ManagedModel;
  onSelectModelPage: (model: ManagedModel) => void;
  formatBytes: (size: number) => string;
}

export function ModelsPage({
  modelVersions,
  modelMessage: _modelMessage,
  downloadingModel,
  modelTargets,
  downloadSections,
  getKnownDownloadSize,
  getDirectDownloadKey,
  getDirectDownloadVersion,
  getModelVersions,
  getModelVersionTitle,
  onDownloadDirectModel,
  onSetActiveModelVersion,
  onRemoveModelVersion,
  activeModel,
  onSelectModelPage,
  formatBytes,
}: ModelsPageProps) {
  function groupDownloadsByRepository(
    downloads: DirectModelDownload[],
  ): RepositoryDownloadGroup[] {
    const groups = new Map<string, RepositoryDownloadGroup>();

    for (const download of downloads) {
      const group = groups.get(download.id);

      if (group === undefined) {
        groups.set(download.id, {
          id: download.id,
          name: download.repositoryName,
          downloads: [download],
        });
      } else {
        group.downloads.push(download);
      }
    }

    return [...groups.values()];
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

  const activeSection =
    downloadSections.find((section) => section.model === activeModel) ??
    downloadSections[0];

  const activeTarget =
    modelTargets.find((target) => target.model === activeSection?.model) ??
    modelTargets[0];

  const versions = activeTarget ? getModelVersions(activeTarget.model) : [];
  const activeVersion = versions.find((version) => version.active);

  return (
    <Page
      title="Model manager"
      headerActions={
        <div className={styles.resultHeaderActions}>
          <span>
            {modelVersions.length} version
            {modelVersions.length === 1 ? '' : 's'}
          </span>
        </div>
      }
    >
      <div className={styles.settingsSubnav}>
        {modelTargets.map((target) => (
          <button
            key={target.model}
            type="button"
            data-active={target.model === activeTarget?.model}
            onClick={() => onSelectModelPage(target.model)}
          >
            {target.label}
          </button>
        ))}
      </div>

      {activeSection !== undefined && activeTarget !== undefined ? (
        <div className={styles.directDownloads} key={activeSection.title}>
          <div>
            <h3>{activeSection.title}</h3>
            <p>{activeSection.description}</p>
          </div>

          <label className={styles.engineModelPicker}>
            <span>Active version</span>
            <select
              value={activeVersion?.version ?? ''}
              onChange={(event) =>
                onSetActiveModelVersion(activeTarget.model, event.target.value)
              }
              disabled={versions.length === 0 || downloadingModel !== null}
            >
              <option value="">
                {versions.length === 0
                  ? 'No downloaded versions'
                  : 'Choose an active version'}
              </option>
              {versions.map((version) => (
                <option
                  key={`${activeTarget.model}-${version.version}`}
                  value={version.version}
                >
                  {getModelVersionTitle(version)}
                  {version.active ? ' (active)' : ''}
                </option>
              ))}
            </select>
          </label>

          <div className={styles.repositoryGrid}>
            {groupDownloadsByRepository(activeSection.downloads).map((repository) => (
              <article className={styles.repositoryCard} key={repository.id}>
                <header>
                  <strong>{repository.name}</strong>
                  <div className={styles.repositoryMetaLine}>
                    <a
                      href={getRepositoryUrl(repository.id)}
                      target="_blank"
                      rel="noreferrer"
                      className={styles.repositoryLink}
                    >
                      {repository.id}
                    </a>
                  </div>
                </header>
                <ul className={styles.variantList}>
                  {repository.downloads.map((download) => {
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
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </Page>
  );
}
