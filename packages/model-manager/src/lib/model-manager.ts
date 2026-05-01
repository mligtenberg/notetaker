import { FileSystem } from '@notetaker/filesystem';

export type ManagedModel = 'whisper' | 'pyannote' | 'gemma4' | 'wav2vec2';

export interface ModelVersionManifestEntry {
  model: ManagedModel;
  modelName: string;
  version: string;
  quantization?: string;
  files: ModelFileManifestEntry[];
  active: boolean;
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
  'whisper',
  'pyannote',
  'gemma4',
  'wav2vec2',
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
    this.#assertValidModel(options.model);
    this.#assertSafePathPart(options.version, 'version');

    if (options.files.length === 0) {
      throw new Error('Model version requires at least one file.');
    }

    const manifest = await this.#readManifest();
    const modelDirectory = await this.#getModelDirectory(options.model);
    const versionDirectory = await modelDirectory.getDirectoryHandle(options.version, {
      create: true,
    });
    const now = new Date().toISOString();
    const fileEntries: ModelFileManifestEntry[] = [];

    for (const file of options.files) {
      fileEntries.push(await this.#writeModelFile(versionDirectory, file, now));
    }

    const existingEntry = manifest.models[options.model][options.version];
    const entry: ModelVersionManifestEntry = {
      model: options.model,
      modelName: options.modelName ?? existingEntry?.modelName ?? options.version,
      version: options.version,
      quantization: options.quantization ?? existingEntry?.quantization,
      files: fileEntries,
      active: options.activate ?? existingEntry?.active ?? false,
      createdAt: existingEntry?.createdAt ?? now,
      updatedAt: now,
      metadata: options.metadata ?? existingEntry?.metadata,
    };

    manifest.models[options.model][options.version] = entry;

    if (entry.active) {
      this.#markOnlyActive(manifest, options.model, options.version);
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

  async removeVersion(model: ManagedModel, version: string): Promise<void> {
    this.#assertValidModel(model);
    this.#assertSafePathPart(version, 'version');

    const manifest = await this.#readManifest();

    delete manifest.models[model][version];
    await this.modelsDirectoryHandle
      .getDirectoryHandle(model)
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
    return this.modelsDirectoryHandle.getDirectoryHandle(model, { create: true });
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
        whisper: {},
        pyannote: {},
        gemma4: {},
        wav2vec2: {},
      },
    };
  }

  #normalizeManifest(manifest: unknown): ModelManifest {
    if (typeof manifest !== 'object' || manifest === null) {
      return this.#createEmptyManifest();
    }

    const partialManifest = manifest as Partial<ModelManifest>;
    const normalized = this.#createEmptyManifest();

    for (const model of MODEL_NAMES) {
      const versions = partialManifest.models?.[model] ?? {};

      normalized.models[model] = Object.fromEntries(
        Object.entries(versions).map(([version, entry]) => [
          version,
          {
            ...entry,
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
