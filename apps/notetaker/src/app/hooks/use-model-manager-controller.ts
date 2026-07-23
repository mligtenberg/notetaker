import { useEffect, useRef, useState } from 'react';
import { FileSystem } from '@notetaker/filesystem';
import {
  ModelManager,
  type ManagedModel,
  type ModelVersionManifestEntry,
} from '@notetaker/model-manager';
import type { DownloadProgressState } from '../app.types';
import {
  downloadFileToVersion,
  getDirectDownloadVersion as findDirectDownloadVersion,
  getKnownDownloadSize,
  getModelVersionTitle,
  getModelVersions as filterModelVersions,
  getQuantizedVersionName,
  type DirectModelDownload,
} from '../services/model-downloads';

const fileSystem = new FileSystem();

export function useModelManagerController() {
  const modelManagerRef = useRef<ModelManager | null>(null);
  const [modelMessage, setModelMessage] = useState(
    'Opening OPFS models folder...',
  );
  const [modelVersions, setModelVersions] = useState<
    ModelVersionManifestEntry[]
  >([]);
  const [downloadingModel, setDownloadingModel] = useState<ManagedModel | null>(
    null,
  );
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgressState | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function setupModels() {
      try {
        const modelManager = await ModelManager.create(fileSystem);

        if (!isMounted) {
          return;
        }

        modelManagerRef.current = modelManager;
        await refreshModelVersions(modelManager);
        setModelMessage('Ready. Manage downloaded model versions in OPFS/models.');
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setModelMessage(
          error instanceof Error
            ? error.message
            : 'Failed to open OPFS models folder.',
        );
      }
    }

    void setupModels();

    return () => {
      isMounted = false;
    };
  }, []);

  async function refreshModelVersions(modelManager = modelManagerRef.current) {
    if (modelManager === null) {
      return;
    }

    setModelVersions(await modelManager.listVersions());
  }

  function getDirectDownloadVersion(
    download: DirectModelDownload,
    versions = modelVersions,
  ): ModelVersionManifestEntry | undefined {
    return findDirectDownloadVersion(download, versions);
  }

  function getModelVersions(model: ManagedModel): ModelVersionManifestEntry[] {
    return filterModelVersions(modelVersions, model);
  }

  function getActiveModelVersion(
    model: ManagedModel,
  ): ModelVersionManifestEntry | undefined {
    return modelVersions.find(
      (version) => version.model === model && version.active,
    );
  }

  function getActiveModelVersionForLanguage(
    model: ManagedModel,
    languageCode: string,
  ): ModelVersionManifestEntry | undefined {
    return (
      modelVersions.find(
        (version) =>
          version.model === model &&
          version.activeLanguages?.includes(languageCode),
      ) ??
      modelVersions.find(
        (version) =>
          version.model === model && version.activeLanguages?.includes('*'),
      )
    );
  }

  async function setActiveModelVersionForLanguage(
    model: ManagedModel,
    version: string,
    languageCode: string,
  ) {
    const modelManager = modelManagerRef.current;

    if (modelManager === null || version.length === 0) {
      return;
    }

    try {
      setModelMessage(`Activating ${model} ${version} for ${languageCode}...`);
      await modelManager.setActiveVersionForLanguage(model, version, languageCode);
      await refreshModelVersions(modelManager);
      setModelMessage(`Activated ${model} ${version} for ${languageCode}.`);
    } catch (error) {
      setModelMessage(
        error instanceof Error ? error.message : 'Failed to activate model.',
      );
    }
  }

  async function setActiveModelVersion(model: ManagedModel, version: string) {
    const modelManager = modelManagerRef.current;

    if (modelManager === null || version.length === 0) {
      return;
    }

    try {
      setModelMessage(`Activating ${model} ${version}...`);
      await modelManager.setActiveVersion(model, version);
      await refreshModelVersions(modelManager);
      setModelMessage(`Activated ${model} ${version}.`);
    } catch (error) {
      setModelMessage(
        error instanceof Error ? error.message : 'Failed to activate model.',
      );
    }
  }

  async function downloadDirectModel(download: DirectModelDownload) {
    const modelManager = modelManagerRef.current;

    if (modelManager === null) {
      setModelMessage('Models folder is not ready yet.');
      return;
    }

    const modelName = getQuantizedVersionName(
      download.id.replaceAll('/', '__'),
      download.quantization,
    );
    const version = `${modelName}--direct--${new Date()
      .toISOString()
      .replaceAll(':', '-')}`;

    try {
      setDownloadingModel(download.model);
      setModelMessage(`Downloading ${download.label} from ${download.id}...`);

      const knownTotalBytes = getKnownDownloadSize(download);
      let completedBytes = 0;
      const fileEntries = [];

      // Each file is written to OPFS as soon as it downloads, instead of
      // holding every Blob in memory until the last one arrives — Gemma's
      // ~3.5 GB payload otherwise peaks at the full model size resident in
      // the tab and the final OPFS write fails silently under the memory
      // pressure.
      for (const [index, file] of download.files.entries()) {
        setDownloadProgress({
          title: `Downloading ${download.label}`,
          currentFile: file.path,
          fileIndex: index + 1,
          fileCount: download.files.length,
          loadedBytes: completedBytes,
          totalBytes: knownTotalBytes ?? null,
          status: 'downloading',
        });

        const fileEntry = await downloadFileToVersion(
          modelManager,
          download.model,
          version,
          file,
          (loadedBytes, fileTotalBytes) => {
            const fallbackTotalBytes =
              knownTotalBytes ?? completedBytes + (fileTotalBytes ?? loadedBytes);
            setDownloadProgress({
              title: `Downloading ${download.label}`,
              currentFile: file.path,
              fileIndex: index + 1,
              fileCount: download.files.length,
              loadedBytes: completedBytes + loadedBytes,
              totalBytes: fallbackTotalBytes,
              status: 'downloading',
            });
          },
        );

        completedBytes += fileEntry.size;
        fileEntries.push(fileEntry);
      }

      setDownloadProgress((currentProgress) =>
        currentProgress === null
          ? null
          : { ...currentProgress, status: 'saving' },
      );

      const isLanguageAware = download.model === 'text-audio-sync';
      await modelManager.finalizeVersion({
        model: download.model,
        modelName,
        version,
        quantization: download.quantization,
        activate: true,
        languageCodes: download.languageCodes,
        activateForLanguages: isLanguageAware ? download.languageCodes : undefined,
        fileEntries,
        metadata: {
          title: download.label,
          format: download.model === 'language' ? 'direct-hugging-face' : 'onnx',
          huggingFaceModelId: download.id,
          quantization: download.quantization,
          sourceUrls: download.files.map((file) => file.url),
          gated: false,
        },
      });

      await refreshModelVersions(modelManager);
      setDownloadProgress((currentProgress) =>
        currentProgress === null
          ? null
          : { ...currentProgress, status: 'complete' },
      );
      setModelMessage(`Downloaded and activated ${download.label}.`);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : `Failed to download ${download.label}.`;

      await modelManager.removeVersion(download.model, version).catch(() => undefined);

      setDownloadProgress((currentProgress) =>
        currentProgress === null
          ? null
          : { ...currentProgress, status: 'error', errorMessage },
      );
      setModelMessage(errorMessage);
    } finally {
      setDownloadingModel(null);
    }
  }

  async function removeModelVersion(
    version: ModelVersionManifestEntry,
  ): Promise<void> {
    const modelManager = modelManagerRef.current;

    if (modelManager === null) {
      setModelMessage('Models folder is not ready yet.');
      return;
    }

    try {
      setModelMessage(`Removing ${getModelVersionTitle(version)}...`);
      await modelManager.removeVersion(version.model, version.version);
      await refreshModelVersions(modelManager);
      setModelMessage(`Removed ${getModelVersionTitle(version)}.`);
    } catch (error) {
      setModelMessage(
        error instanceof Error ? error.message : 'Failed to remove model.',
      );
    }
  }

  return {
    modelVersions,
    modelMessage,
    downloadingModel,
    downloadProgress,
    setDownloadProgress,
    getDirectDownloadVersion,
    getModelVersions,
    getActiveModelVersion,
    getActiveModelVersionForLanguage,
    setActiveModelVersion,
    setActiveModelVersionForLanguage,
    downloadDirectModel,
    removeModelVersion,
  };
}
