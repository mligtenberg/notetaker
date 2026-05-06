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
import { DownloadsPanel } from '../models/DownloadsPanel';
import { Page } from '../common/page';

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
  onSetActiveModelVersionForLanguage: (
    model: ManagedModel,
    version: string,
    languageCode: string,
  ) => void;
  onRemoveModelVersion: (version: ModelVersionManifestEntry) => void;
  activeModel: ManagedModel;
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
  onSetActiveModelVersionForLanguage,
  onRemoveModelVersion,
  activeModel,
  formatBytes,
}: ModelsPageProps) {
  return (
    <Page
      title="Model manager"
      subtitle="Manage local models used by the processing pipeline."
      headerActions={
        <div className={styles.resultHeaderActions}>
          <span>
            {modelVersions.length} version
            {modelVersions.length === 1 ? '' : 's'}
          </span>
        </div>
      }
    >
      <DownloadsPanel
        modelVersions={modelVersions}
        modelMessage={_modelMessage}
        downloadingModel={downloadingModel}
        modelTargets={modelTargets}
        downloadSections={downloadSections}
        getKnownDownloadSize={getKnownDownloadSize}
        getDirectDownloadKey={getDirectDownloadKey}
        getDirectDownloadVersion={getDirectDownloadVersion}
        getModelVersions={getModelVersions}
        getModelVersionTitle={getModelVersionTitle}
        onDownloadDirectModel={onDownloadDirectModel}
        onSetActiveModelVersion={onSetActiveModelVersion}
        onSetActiveModelVersionForLanguage={onSetActiveModelVersionForLanguage}
        onRemoveModelVersion={onRemoveModelVersion}
        activeModel={activeModel}
        formatBytes={formatBytes}
      />
    </Page>
  );
}
