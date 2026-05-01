import { ModelManager, type ManagedModel } from '@notetaker/model-manager';

export const LOCAL_URL = 'https://notetaker.local.invalid/models/';

export class ModelCache implements Cache {
  constructor(
    private modelManager: ModelManager,
    private baseUrl: string,
  ) {}

  add(request: RequestInfo | URL): Promise<void> {
    return Promise.resolve(undefined);
  }

  addAll(requests: RequestInfo[]): Promise<void>;
  addAll(requests: Iterable<RequestInfo>): Promise<void>;
  addAll(requests: RequestInfo[] | Iterable<RequestInfo>): Promise<void> {
    return Promise.resolve(undefined);
  }

  delete(
    request: RequestInfo | URL,
    options?: CacheQueryOptions,
  ): Promise<boolean> {
    return Promise.resolve(false);
  }

  keys(
    request?: RequestInfo | URL,
    options?: CacheQueryOptions,
  ): Promise<ReadonlyArray<Request>> {
    return Promise.resolve([]);
  }

  async match(
    request: RequestInfo | URL,
    options?: CacheQueryOptions,
  ): Promise<Response | undefined> {
    if (request instanceof URL) {
      request = request.toString();
    }

    const requestUrl = typeof request === 'string' ? request : request.url;

    const file = await this.#getRequestedModelFile(requestUrl);

    if (file === undefined) {
      return undefined;
    }

    const blob = await file.getFile();

    return new Response(blob, {
      headers: {
        'content-length': String(blob.size),
        'content-type': blob.type,
      },
    });
  }

  async matchAll(
    request?: RequestInfo | URL,
    options?: CacheQueryOptions,
  ): Promise<ReadonlyArray<Response>> {
    if (!request) {
      return [];
    }

    const response = await this.match(request, options);
    return response ? [response] : [];
  }

  put(request: RequestInfo | URL, response: Response): Promise<void> {
    return Promise.resolve(undefined);
  }

  async #getRequestedModelFile(requestUrl: string) {
    const filePath = this.#getRequestFilePath(requestUrl);

    if (filePath === undefined) {
      return undefined;
    }

    const [model, version, ...modelFilePathParts] = filePath.split('/');

    if (
      !this.#isManagedModel(model) ||
      version === undefined ||
      modelFilePathParts.length === 0
    ) {
      return undefined;
    }

    try {
      return await this.modelManager.getModelFile(
        model,
        version,
        modelFilePathParts.join('/'),
      );
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotFoundError') {
        return undefined;
      }

      throw e;
    }
  }

  #getRequestFilePath(requestUrl: string) {
    if (requestUrl.startsWith(this.baseUrl)) {
      return this.#normalizeFilePath(requestUrl.substring(this.baseUrl.length));
    }

    if (requestUrl.startsWith(LOCAL_URL)) {
      return this.#normalizeFilePath(requestUrl.substring(LOCAL_URL.length));
    }

    try {
      const url = new URL(requestUrl);
      return this.#normalizeFilePath(url.pathname);
    } catch {
      return this.#normalizeFilePath(requestUrl);
    }
  }

  #normalizeFilePath(filePath: string) {
    return decodeURIComponent(filePath.split(/[?#]/, 1)[0].replace(/^\/+/, ''));
  }

  #isManagedModel(model: string | undefined): model is ManagedModel {
    return (
      model === 'whisper' ||
      model === 'pyannote' ||
      model === 'gemma4' ||
      model === 'wav2vec2'
    );
  }
}
