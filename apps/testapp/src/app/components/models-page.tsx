import type {
  ManagedModel,
  ModelVersionManifestEntry,
} from '@notetaker/model-manager';
import type { SuggestedModelScores } from '../suggested-model-downloads.config';
import styles from '../app.module.css';

interface DirectModelFile {
  path: string;
  url: string;
  type: string;
  size: number;
}

interface DirectModelDownload {
  id: string;
  repositoryName: string;
  label: string;
  description: string;
  model: ManagedModel;
  scores: SuggestedModelScores;
  quantization?: string;
  files: DirectModelFile[];
}

interface RepositoryDownloadGroup {
  id: string;
  name: string;
  downloads: DirectModelDownload[];
}

interface ModelDownloadTarget {
  model: ManagedModel;
  label: string;
  description: string;
}

interface DownloadSection {
  title: string;
  description: string;
  downloads: DirectModelDownload[];
  buttonLabel: string;
  downloadingLabel: string;
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
  getModelVersionDetail: (version: ModelVersionManifestEntry) => string;
  onDownloadDirectModel: (download: DirectModelDownload) => void;
  onSetActiveModelVersion: (model: ManagedModel, version: string) => void;
  onRemoveModelVersion: (version: ModelVersionManifestEntry) => void;
  formatBytes: (size: number) => string;
}

export function ModelsPage({
  modelVersions,
  modelMessage,
  downloadingModel,
  modelTargets,
  downloadSections,
  getKnownDownloadSize,
  getDirectDownloadKey,
  getDirectDownloadVersion,
  getModelVersions,
  getModelVersionTitle,
  getModelVersionDetail,
  onDownloadDirectModel,
  onSetActiveModelVersion,
  onRemoveModelVersion,
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

  return (
    <section className={styles.panel}>
      <div className={styles.listHeader}>
        <div>
          <p className={styles.label}>OPFS/models</p>
          <h2>Model manager</h2>
        </div>
        <div className={styles.resultHeaderActions}>
          <span>
            {modelVersions.length} version
            {modelVersions.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      <p className={styles.message}>{modelMessage}</p>

      {downloadSections.map((section) => (
        <div className={styles.directDownloads} key={section.title}>
          <div>
            <h3>{section.title}</h3>
            <p>{section.description}</p>
          </div>
          <div className={styles.repositoryGrid}>
            {groupDownloadsByRepository(section.downloads).map((repository) => (
              <article className={styles.repositoryCard} key={repository.id}>
                <header>
                  <strong>{repository.name}</strong>
                  <span>{repository.id}</span>
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
                              ? section.downloadingLabel
                              : section.buttonLabel}
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
      ))}

      <div className={styles.modelGrid}>
        {modelTargets.map((target) => {
          const versions = getModelVersions(target.model);
          const activeModel = versions.find((version) => version.active);

          return (
            <article className={styles.modelCard} key={target.model}>
              <div>
                <strong>{target.label}</strong>
                <span>{target.description}</span>
                <span>
                  Active:{' '}
                  {activeModel === undefined
                    ? 'none'
                    : getModelVersionTitle(activeModel)}
                </span>
              </div>
              <label className={styles.engineModelPicker}>
                <span>Set active version</span>
                <select
                  value={activeModel?.version ?? ''}
                  onChange={(event) =>
                    onSetActiveModelVersion(target.model, event.target.value)
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
                      key={`${target.model}-${version.version}`}
                      value={version.version}
                    >
                      {getModelVersionTitle(version)}
                      {version.active ? ' (active)' : ''}
                    </option>
                  ))}
                </select>
              </label>

              {versions.length > 0 ? (
                <ul className={styles.modelVersionList}>
                  {versions.map((version) => (
                    <li key={`${version.model}-${version.version}`}>
                      <div>
                        <strong>{getModelVersionTitle(version)}</strong>
                        <span>{getModelVersionDetail(version)}</span>
                        <span>
                          {version.model}
                          {version.active ? ' | active' : ''}
                        </span>
                      </div>
                      <button
                        type="button"
                        className={styles.dangerButton}
                        onClick={() => onRemoveModelVersion(version)}
                        disabled={downloadingModel !== null}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.empty}>No models downloaded yet.</p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
