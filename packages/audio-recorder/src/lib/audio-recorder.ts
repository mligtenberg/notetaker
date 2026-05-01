export interface AudioRecorderOptions {
  fileName?: string;
  mimeType?: string;
  audioBitsPerSecond?: number;
}

export interface AudioRecordingResult {
  blob: Blob;
  fileHandle: FileSystemFileHandle;
  fileName: string;
  mimeType: string;
  size: number;
}

const DEFAULT_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
] as const;

export class AudioRecorder {
  readonly directoryHandle: FileSystemDirectoryHandle;

  #chunks: Blob[] = [];
  #mediaRecorder: MediaRecorder | null = null;
  #stream: MediaStream | null = null;
  #state: 'inactive' | 'recording' = 'inactive';

  constructor(directoryHandle: FileSystemDirectoryHandle) {
    this.directoryHandle = directoryHandle;
  }

  get state(): 'inactive' | 'recording' {
    return this.#state;
  }

  async start(options: AudioRecorderOptions = {}): Promise<void> {
    if (this.#mediaRecorder !== null || this.#state === 'recording') {
      throw new Error('Audio recorder is already recording.');
    }

    this.#assertBrowserSupport();

    const mimeType = this.#resolveMimeType(options.mimeType);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    try {
      const mediaRecorder = new MediaRecorder(stream, {
        audioBitsPerSecond: options.audioBitsPerSecond,
        mimeType,
      });

      this.#chunks = [];
      this.#stream = stream;
      this.#mediaRecorder = mediaRecorder;

      mediaRecorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          this.#chunks.push(event.data);
        }
      });

      mediaRecorder.addEventListener(
        'stop',
        () => {
          this.#cleanupStream();
          this.#state = 'inactive';
          this.#mediaRecorder = null;
        },
        { once: true },
      );

      mediaRecorder.start();
      this.#state = 'recording';
    } catch (error) {
      this.#cleanupStream();
      this.#stream = null;
      throw error;
    }
  }

  async stop(
    options: AudioRecorderOptions = {},
  ): Promise<AudioRecordingResult> {
    const mediaRecorder = this.#mediaRecorder;
    if (mediaRecorder === null || this.#state !== 'recording') {
      throw new Error('Audio recorder is not recording.');
    }

    const mimeType =
      mediaRecorder.mimeType || this.#resolveMimeType(options.mimeType);
    const fileName = this.#resolveFileName(mimeType, options.fileName);
    const stopped = new Promise<void>((resolve, reject) => {
      mediaRecorder.addEventListener('stop', () => resolve(), { once: true });
      mediaRecorder.addEventListener('error', (event) => reject(event.error), {
        once: true,
      });
    });

    mediaRecorder.stop();
    await stopped;

    const blob = new Blob(this.#chunks, { type: mimeType });
    this.#chunks = [];

    const fileHandle = await this.directoryHandle.getFileHandle(fileName, {
      create: true,
    });
    const writable = await fileHandle.createWritable();

    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      await writable.abort();
      throw error;
    }

    return {
      blob,
      fileHandle,
      fileName,
      mimeType,
      size: blob.size,
    };
  }

  cancel(): void {
    if (this.#mediaRecorder?.state === 'recording') {
      this.#chunks = [];
      this.#mediaRecorder.stop();
      return;
    }

    this.#cleanupStream();
    this.#mediaRecorder = null;
    this.#chunks = [];
    this.#state = 'inactive';
  }

  #assertBrowserSupport(): void {
    if (
      typeof navigator === 'undefined' ||
      navigator.mediaDevices?.getUserMedia === undefined
    ) {
      throw new Error(
        'Audio recording requires navigator.mediaDevices.getUserMedia().',
      );
    }

    if (typeof MediaRecorder === 'undefined') {
      throw new Error('Audio recording requires MediaRecorder support.');
    }
  }

  #resolveMimeType(requestedMimeType?: string): string {
    if (requestedMimeType !== undefined) {
      if (!MediaRecorder.isTypeSupported(requestedMimeType)) {
        throw new Error(`Unsupported audio mime type: ${requestedMimeType}`);
      }

      return requestedMimeType;
    }

    for (const mimeType of DEFAULT_MIME_TYPES) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        return mimeType;
      }
    }

    throw new Error('No supported audio recording mime type was found.');
  }

  #resolveFileName(mimeType: string, fileName?: string): string {
    if (fileName !== undefined) {
      return fileName;
    }

    const extension = this.#mimeTypeToExtension(mimeType);
    const stamp = new Date().toISOString().replace(/:/g, '-');
    return `recording-${stamp}.${extension}`;
  }

  #mimeTypeToExtension(mimeType: string): string {
    if (mimeType.includes('mp4')) {
      return 'm4a';
    }

    if (mimeType.includes('ogg')) {
      return 'ogg';
    }

    return 'webm';
  }

  #cleanupStream(): void {
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = null;
  }
}
