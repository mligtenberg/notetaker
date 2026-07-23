import { FileSystem } from '@notetaker/filesystem';

export type ManagedModel =
  | 'transcription'
  | 'diarization'
  | 'language'
  | 'text-audio-sync';

type LegacyManagedModel = 'whisper' | 'pyannote' | 'gemma4' | 'wav2vec2';

const LEGACY_MODEL_NAME_MAP: Record<LegacyManagedModel, ManagedModel> = {
  whisper: 'transcription',
  pyannote: 'diarization',
  gemma4: 'language',
  wav2vec2: 'text-audio-sync',
};

const MODEL_DIRECTORY_NAMES: Record<ManagedModel, string> = {
  transcription: 'whisper',
  diarization: 'pyannote',
  language: 'gemma4',
  'text-audio-sync': 'wav2vec2',
};

export interface ModelVersionManifestEntry {
  model: ManagedModel;
  modelName: string;
  version: string;
  quantization?: string;
  files: ModelFileManifestEntry[];
  active: boolean;
  languageCodes?: string[];
  activeLanguages?: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface ModelFileManifestEntry {
  path: string;
  size: number;
  type: string;
  updatedAt: string;
}

export interface AddModelVersionOptions {
  model: ManagedModel;
  modelName?: string;
  version: string;
  quantization?: string;
  files: ModelVersionFile[];
  activate?: boolean;
  languageCodes?: string[];
  activateForLanguages?: string[];
  metadata?: Record<string, unknown>;
}

export interface ModelVersionFile {
  path: string;
  data: Blob | BufferSource | string;
  type?: string;
}

export interface StoredModelVersion {
  manifest: ModelVersionManifestEntry;
  directoryHandle: FileSystemDirectoryHandle;
}

interface ModelManifest {
  schemaVersion: 1;
  models: Record<ManagedModel, Record<string, ModelVersionManifestEntry>>;
}

const MANIFEST_FILE_NAME = 'manifest.json';
const MODEL_NAMES = [
  'transcription',
  'diarization',
  'language',
  'text-audio-sync',
] as const satisfies readonly ManagedModel[];

export class ModelManager {
  readonly modelsDirectoryHandle: FileSystemDirectoryHandle;

  constructor(modelsDirectoryHandle: FileSystemDirectoryHandle) {
    this.modelsDirectoryHandle = modelsDirectoryHandle;
  }

  static async create(fileSystem = new FileSystem()): Promise<ModelManager> {
    return new ModelManager(await fileSystem.getModelsDir());
  }

  async addVersion(options: AddModelVersionOptions): Promise<ModelVersionManifestEntry> {
    if (options.files.length === 0) {
      throw new Error('Model version requires at least one file.');
    }

    const now = new Date().toISOString();
    const fileEntries: ModelFileManifestEntry[] = [];

    for (const file of options.files) {
      fileEntries.push(await this.writeVersionFile(options.model, options.version, file, now));
    }

    return this.finalizeVersion({ ...options, fileEntries });
  }

  /**
   * Writes a single model file to a version's directory (creating it on first
   * call) without touching the manifest. Lets callers stream a large model in
   * one file at a time instead of holding every file's Blob in memory before
   * any of it reaches disk.
   */
  async writeVersionFile(
    model: ManagedModel,
    version: string,
    file: ModelVersionFile,
    updatedAt: string = new Date().toISOString(),
  ): Promise<ModelFileManifestEntry> {
    this.#assertValidModel(model);
    this.#assertSafePathPart(version, 'version');

    const modelDirectory = await this.#getModelDirectory(model);
    const versionDirectory = await modelDirectory.getDirectoryHandle(version, {
      create: true,
    });

    return this.#writeModelFile(versionDirectory, file, updatedAt);
  }

  /**
   * Opens a writable for a single model file without requiring its full
   * content up front. Lets a caller pipe a fetch response's body straight to
   * disk in whatever chunk sizes the network hands over, so even a
   * multi-gigabyte file never needs to be held in memory as one Blob.
   */
  async openVersionFileWritable(
    model: ManagedModel,
    version: string,
    path: string,
  ): Promise<FileSystemWritableFileStream> {
    this.#assertValidModel(model);
    this.#assertSafePathPart(version, 'version');

    const pathParts = this.#resolveFilePath(path);
    const fileName = pathParts.at(-1);

    if (fileName === undefined) {
      throw new Error('Model file path must include a file name.');
    }

    const modelDirectory = await this.#getModelDirectory(model);
    let directory = await modelDirectory.getDirectoryHandle(version, {
      create: true,
    });

    for (const directoryName of pathParts.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(directoryName, { create: true });
    }

    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    return fileHandle.createWritable();
  }

  /**
   * Records manifest metadata for a version whose files were already written
   * via {@link writeVersionFile}. Split from {@link addVersion} so large
   * downloads can write files incrementally and finalize once at the end.
   */
  async finalizeVersion(
    options: Omit<AddModelVersionOptions, 'files'> & {
      fileEntries: ModelFileManifestEntry[];
    },
  ): Promise<ModelVersionManifestEntry> {
    this.#assertValidModel(options.model);
    this.#assertSafePathPart(options.version, 'version');

    if (options.fileEntries.length === 0) {
      throw new Error('Model version requires at least one file.');
    }

    const manifest = await this.#readManifest();
    const now = new Date().toISOString();
    const fileEntries = options.fileEntries;
    const existingEntry = manifest.models[options.model][options.version];
    const languageCodes =
      options.languageCodes ?? existingEntry?.languageCodes;
    const activateForLanguages = options.activateForLanguages;
    const initialActiveLanguages =
      activateForLanguages ?? existingEntry?.activeLanguages ?? [];
    const activate =
      options.activate ??
      (activateForLanguages !== undefined && activateForLanguages.length > 0
        ? true
        : (existingEntry?.active ?? false));
    const entry: ModelVersionManifestEntry = {
      model: options.model,
      modelName: options.modelName ?? existingEntry?.modelName ?? options.version,
      version: options.version,
      quantization: options.quantization ?? existingEntry?.quantization,
      files: fileEntries,
      active: activate,
      languageCodes,
      activeLanguages: initialActiveLanguages,
      createdAt: existingEntry?.createdAt ?? now,
      updatedAt: now,
      metadata: options.metadata ?? existingEntry?.metadata,
    };

    manifest.models[options.model][options.version] = entry;

    if (entry.active) {
      this.#markOnlyActive(manifest, options.model, options.version);
    }

    if (activateForLanguages !== undefined) {
      for (const language of activateForLanguages) {
        this.#assignLanguageActive(manifest, options.model, options.version, language);
      }
    }

    await this.#writeManifest(manifest);
    return entry;
  }

  async listVersions(model?: ManagedModel): Promise<ModelVersionManifestEntry[]> {
    if (model !== undefined) {
      this.#assertValidModel(model);
    }

    const manifest = await this.#readManifest();
    const models = model === undefined ? MODEL_NAMES : [model];

    return models
      .flatMap((modelName) => Object.values(manifest.models[modelName]))
      .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
  }

  async getVersion(
    model: ManagedModel,
    version: string,
  ): Promise<StoredModelVersion | null> {
    this.#assertValidModel(model);
    this.#assertSafePathPart(version, 'version');

    const manifest = await this.#readManifest();
    const entry = manifest.models[model][version];

    if (entry === undefined) {
      return null;
    }

    return {
      manifest: entry,
      directoryHandle: await this.#getVersionDirectory(model, version),
    };
  }

  async getActiveVersion(model: ManagedModel): Promise<StoredModelVersion | null> {
    this.#assertValidModel(model);

    const manifest = await this.#readManifest();
    const entry = Object.values(manifest.models[model]).find((version) => version.active);

    if (entry === undefined) {
      return null;
    }

    return {
      manifest: entry,
      directoryHandle: await this.#getVersionDirectory(model, entry.version),
    };
  }

  async setActiveVersion(
    model: ManagedModel,
    version: string,
  ): Promise<ModelVersionManifestEntry> {
    this.#assertValidModel(model);
    this.#assertSafePathPart(version, 'version');

    const manifest = await this.#readManifest();
    const entry = manifest.models[model][version];

    if (entry === undefined) {
      throw new Error(`Model version does not exist: ${model}@${version}`);
    }

    this.#markOnlyActive(manifest, model, version);
    entry.updatedAt = new Date().toISOString();
    await this.#writeManifest(manifest);
    return entry;
  }

  async getActiveVersionForLanguage(
    model: ManagedModel,
    languageCode: string,
  ): Promise<StoredModelVersion | null> {
    this.#assertValidModel(model);

    const manifest = await this.#readManifest();
    const entries = Object.values(manifest.models[model]);
    const entry =
      entries.find((version) => version.activeLanguages?.includes(languageCode)) ??
      entries.find((version) => version.activeLanguages?.includes('*'));

    if (entry === undefined) {
      return null;
    }

    return {
      manifest: entry,
      directoryHandle: await this.#getVersionDirectory(model, entry.version),
    };
  }

  async setActiveVersionForLanguage(
    model: ManagedModel,
    version: string,
    languageCode: string,
  ): Promise<ModelVersionManifestEntry> {
    this.#assertValidModel(model);
    this.#assertSafePathPart(version, 'version');

    const manifest = await this.#readManifest();
    const entry = manifest.models[model][version];

    if (entry === undefined) {
      throw new Error(`Model version does not exist: ${model}@${version}`);
    }

    this.#assignLanguageActive(manifest, model, version, languageCode);
    entry.updatedAt = new Date().toISOString();
    await this.#writeManifest(manifest);
    return entry;
  }

  async removeVersion(model: ManagedModel, version: string): Promise<void> {
    this.#assertValidModel(model);
    this.#assertSafePathPart(version, 'version');

    const manifest = await this.#readManifest();

    delete manifest.models[model][version];
    await this.modelsDirectoryHandle
      .getDirectoryHandle(MODEL_DIRECTORY_NAMES[model])
      .then((modelDirectory) => modelDirectory.removeEntry(version, { recursive: true }))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException) || error.name !== 'NotFoundError') {
          throw error;
        }
      });
    await this.#writeManifest(manifest);
  }

  async getModelFile(
    model: ManagedModel,
    version: string,
    path: string,
  ): Promise<FileSystemFileHandle> {
    this.#assertValidModel(model);
    this.#assertSafePathPart(version, 'version');

    const pathParts = this.#resolveFilePath(path);
    const fileName = pathParts.at(-1);

    if (fileName === undefined) {
      throw new Error('Model file path must include a file name.');
    }

    let directory = await this.#getVersionDirectory(model, version);

    for (const directoryName of pathParts.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(directoryName);
    }

    return directory.getFileHandle(fileName);
  }

  async #writeModelFile(
    versionDirectory: FileSystemDirectoryHandle,
    file: ModelVersionFile,
    updatedAt: string,
  ): Promise<ModelFileManifestEntry> {
    const pathParts = this.#resolveFilePath(file.path);
    const fileName = pathParts.at(-1);

    if (fileName === undefined) {
      throw new Error('Model file path must include a file name.');
    }

    let directory = versionDirectory;

    for (const directoryName of pathParts.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(directoryName, { create: true });
    }

    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    const blob = file.data instanceof Blob ? file.data : new Blob([file.data], { type: file.type });

    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      await writable.abort();
      throw error;
    }

    return {
      path: pathParts.join('/'),
      size: blob.size,
      type: blob.type || file.type || 'application/octet-stream',
      updatedAt,
    };
  }

  async #getModelDirectory(model: ManagedModel): Promise<FileSystemDirectoryHandle> {
    return this.modelsDirectoryHandle.getDirectoryHandle(
      MODEL_DIRECTORY_NAMES[model],
      { create: true },
    );
  }

  async #getVersionDirectory(
    model: ManagedModel,
    version: string,
  ): Promise<FileSystemDirectoryHandle> {
    const modelDirectory = await this.#getModelDirectory(model);
    return modelDirectory.getDirectoryHandle(version);
  }

  async #readManifest(): Promise<ModelManifest> {
    try {
      const fileHandle = await this.modelsDirectoryHandle.getFileHandle(MANIFEST_FILE_NAME);
      const file = await fileHandle.getFile();
      return this.#normalizeManifest(JSON.parse(await file.text()));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        const manifest = this.#createEmptyManifest();
        await this.#writeManifest(manifest);
        return manifest;
      }

      throw error;
    }
  }

  async #writeManifest(manifest: ModelManifest): Promise<void> {
    const fileHandle = await this.modelsDirectoryHandle.getFileHandle(MANIFEST_FILE_NAME, {
      create: true,
    });
    const writable = await fileHandle.createWritable();

    try {
      await writable.write(JSON.stringify(manifest, null, 2));
      await writable.close();
    } catch (error) {
      await writable.abort();
      throw error;
    }
  }

  #createEmptyManifest(): ModelManifest {
    return {
      schemaVersion: 1,
      models: {
        transcription: {},
        diarization: {},
        language: {},
        'text-audio-sync': {},
      },
    };
  }

  #normalizeManifest(manifest: unknown): ModelManifest {
    if (typeof manifest !== 'object' || manifest === null) {
      return this.#createEmptyManifest();
    }

    const partialManifest = manifest as {
      models?: Partial<Record<string, Record<string, ModelVersionManifestEntry>>>;
    };
    const normalized = this.#createEmptyManifest();

    for (const model of MODEL_NAMES) {
      const legacyKey = (Object.keys(LEGACY_MODEL_NAME_MAP) as LegacyManagedModel[]).find(
        (key) => LEGACY_MODEL_NAME_MAP[key] === model,
      );
      const versions =
        partialManifest.models?.[model] ??
        (legacyKey ? partialManifest.models?.[legacyKey] : undefined) ??
        {};

      normalized.models[model] = Object.fromEntries(
        Object.entries(versions).map(([version, entry]) => [
          version,
          {
            ...entry,
            model,
            modelName: entry.modelName ?? entry.version,
          },
        ]),
      );
    }

    return normalized;
  }

  #markOnlyActive(manifest: ModelManifest, model: ManagedModel, version: string): void {
    for (const entry of Object.values(manifest.models[model])) {
      entry.active = entry.version === version;
    }
  }

  #assignLanguageActive(
    manifest: ModelManifest,
    model: ManagedModel,
    version: string,
    languageCode: string,
  ): void {
    for (const entry of Object.values(manifest.models[model])) {
      const languages = entry.activeLanguages ?? [];

      if (entry.version === version) {
        entry.activeLanguages = languages.includes(languageCode)
          ? languages
          : [...languages, languageCode];
      } else if (languages.includes(languageCode)) {
        entry.activeLanguages = languages.filter((code) => code !== languageCode);
      }

      entry.active = (entry.activeLanguages?.length ?? 0) > 0;
    }
  }

  #resolveFilePath(path: string): string[] {
    const parts = path.split('/').filter(Boolean);

    if (parts.length === 0) {
      throw new Error('Model file path must not be empty.');
    }

    for (const part of parts) {
      this.#assertSafePathPart(part, 'file path');
    }

    return parts;
  }

  #assertValidModel(model: ManagedModel): void {
    if (!MODEL_NAMES.includes(model)) {
      throw new Error(`Unsupported model: ${model}`);
    }
  }

  #assertSafePathPart(value: string, label: string): void {
    if (value.length === 0 || value === '.' || value === '..' || value.includes('/')) {
      throw new Error(`Invalid ${label}: ${value}`);
    }
  }
}
