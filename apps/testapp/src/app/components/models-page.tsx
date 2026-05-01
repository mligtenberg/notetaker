import type { ManagedModel, ModelVersionManifestEntry } from '@notetaker/model-manager';
import styles from '../app.module.css';

interface DirectModelFile {
  path: string;
  url: string;
  type: string;
  size: number;
}

interface DirectModelDownload {
  id: string;
  label: string;
  description: string;
  model: ManagedModel;
  quantization?: string;
  files: DirectModelFile[];
}

interface ModelDownloadTarget {
  model: ManagedModel;
  label: string;
  description: string;
}

interface DownloadSection {
  eyebrow: string;
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
  return (
    <section className={styles.panel}>
      <div className={styles.listHeader}>
        <div>
          <p className={styles.label}>OPFS/models</p>
          <h2>Model manager</h2>
        </div>
        <span>
          {modelVersions.length} version{modelVersions.length === 1 ? '' : 's'}
        </span>
      </div>
      <p className={styles.message}>{modelMessage}</p>

      {downloadSections.map((section) => (
        <div className={styles.directDownloads} key={section.title}>
          <div>
            <p className={styles.label}>{section.eyebrow}</p>
            <h3>{section.title}</h3>
            <p>{section.description}</p>
          </div>
          <div className={styles.presetGrid}>
            {section.downloads.map((download) => {
              const downloadedVersion = getDirectDownloadVersion(download);

              return (
                <article key={getDirectDownloadKey(download)}>
                  <strong>{download.label}</strong>
                  <span>{download.id}</span>
                  <span>{formatBytes(getKnownDownloadSize(download))}</span>
                  {downloadedVersion !== undefined ? (
                    <span className={styles.downloadedBadge}>downloaded</span>
                  ) : null}
                  <p>{download.description}</p>
                  <button
                    type="button"
                    onClick={() => onDownloadDirectModel(download)}
                    disabled={
                      downloadingModel !== null || downloadedVersion !== undefined
                    }
                  >
                    {downloadedVersion !== undefined
                      ? 'Downloaded'
                      : downloadingModel === download.model
                        ? section.downloadingLabel
                        : section.buttonLabel}
                  </button>
                </article>
              );
            })}
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
