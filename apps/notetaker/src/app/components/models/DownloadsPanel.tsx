import type {
  ManagedModel,
  ModelVersionManifestEntry,
} from '@notetaker/model-manager';
import type {
  DirectModelDownload,
  DownloadSection,
  ModelDownloadTarget,
} from '../../services/model-downloads';
import styles from '../../app.module.css';
import { Tabs, type TabItem } from '../common/tabs';
import { RepositoryCard } from './RepositoryCard';
import { getModelPagePath } from "../../app-routing";

interface RepositoryDownloadGroup {
  id: string;
  name: string;
  downloads: DirectModelDownload[];
}

interface DownloadsPanelProps {
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
  onSetActiveModelVersionForLanguage: (
    model: ManagedModel,
    version: string,
    languageCode: string,
  ) => void;
  onRemoveModelVersion: (version: ModelVersionManifestEntry) => void;
  activeModel: ManagedModel;
  formatBytes: (size: number) => string;
}

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

export function DownloadsPanel({
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
  onSetActiveModelVersionForLanguage,
  onRemoveModelVersion,
  activeModel,
  formatBytes,
}: DownloadsPanelProps) {
  const activeSection =
    downloadSections.find((section) => section.model === activeModel) ??
    downloadSections[0];

  const activeTarget =
    modelTargets.find((target) => target.model === activeSection?.model) ??
    modelTargets[0];

  const versions = activeTarget ? getModelVersions(activeTarget.model) : [];
  const activeVersion = versions.find((version) => version.active);
  const isLanguageAware = activeTarget?.model === 'text-audio-sync';

  const downloadedLanguageCodes = isLanguageAware
    ? [
        ...new Set(
          versions.flatMap((version) => version.languageCodes ?? []),
        ),
      ].sort((first, second) => {
        if (first === '*') return 1;
        if (second === '*') return -1;
        return first.localeCompare(second);
      })
    : [];

  const tabItems: TabItem[] = modelTargets.map((target) => ({
    label: target.label,
    path: getModelPagePath(target.model),
  }));

  return (
    <>
      <Tabs
        items={tabItems}
        activePath={getModelPagePath(activeTarget?.model ?? '')}
      />

      {activeSection !== undefined && activeTarget !== undefined ? (
        <>
          <div>
            <h3>{activeSection.title}</h3>
            <p>{activeSection.description}</p>
          </div>

          {isLanguageAware ? (
            downloadedLanguageCodes.length === 0 ? (
              <label className={styles.engineModelPicker}>
                <span>Active version</span>
                <select disabled>
                  <option value="">No downloaded versions</option>
                </select>
              </label>
            ) : (
              downloadedLanguageCodes.map((languageCode) => {
                const compatibleVersions = versions.filter((version) =>
                  version.languageCodes?.includes(languageCode),
                );
                const activeForLanguage = compatibleVersions.find((version) =>
                  version.activeLanguages?.includes(languageCode),
                );

                return (
                  <label
                    key={`${activeTarget.model}-lang-${languageCode}`}
                    className={styles.engineModelPicker}
                  >
                    <span>
                      Active version (
                      {languageCode === '*' ? 'all languages' : languageCode})
                    </span>
                    <select
                      value={activeForLanguage?.version ?? ''}
                      onChange={(event) =>
                        onSetActiveModelVersionForLanguage(
                          activeTarget.model,
                          event.target.value,
                          languageCode,
                        )
                      }
                      disabled={downloadingModel !== null}
                    >
                      <option value="">Choose an active version</option>
                      {compatibleVersions.map((version) => (
                        <option
                          key={`${activeTarget.model}-${languageCode}-${version.version}`}
                          value={version.version}
                        >
                          {getModelVersionTitle(version)}
                          {version.activeLanguages?.includes(languageCode)
                            ? ' (active)'
                            : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })
            )
          ) : (
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
          )}

          <div className={styles.repositoryGrid}>
            {groupDownloadsByRepository(activeSection.downloads).map((repository) => (
              <RepositoryCard
                key={repository.id}
                repositoryId={repository.id}
                repositoryName={repository.name}
                downloads={repository.downloads}
                downloadingModel={downloadingModel}
                getKnownDownloadSize={getKnownDownloadSize}
                getDirectDownloadKey={getDirectDownloadKey}
                getDirectDownloadVersion={getDirectDownloadVersion}
                onDownloadDirectModel={onDownloadDirectModel}
                onRemoveModelVersion={onRemoveModelVersion}
                activeSection={activeSection}
                formatBytes={formatBytes}
              />
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
