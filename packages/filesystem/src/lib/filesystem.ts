export class FileSystem {
  async getMeetingsDir(): Promise<FileSystemDirectoryHandle> {
    return this.#getDirectory('meetings');
  }

  async getModelsDir(): Promise<FileSystemDirectoryHandle> {
    return this.#getDirectory('models');
  }

  async #getDirectory(name: string): Promise<FileSystemDirectoryHandle> {
    if (typeof navigator === 'undefined' || navigator.storage?.getDirectory === undefined) {
      throw new Error('OPFS requires navigator.storage.getDirectory() support.');
    }

    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(name, { create: true });
  }
}
