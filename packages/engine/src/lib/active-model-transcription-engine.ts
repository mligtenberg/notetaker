import {
  AutomaticSpeechRecognitionPipeline,
  WhisperTextStreamer,
  env,
  pipeline,
} from '@huggingface/transformers';
import {
  type ManagedModel,
  type ModelManager,
  type ModelVersionManifestEntry,
} from '@notetaker/model-manager';
import type { Meeting } from './models/meeting';
import type { Transcript } from './models/transcript';
import type { TranscriptSegment } from './models/transcript-segment';
import type { TranscriptionEngine } from './transcription-engine';

type ModelSelections = Partial<Record<ManagedModel, string>>;
type WhisperDtype = 'q8' | 'fp32';
type WhisperTask = 'transcribe' | 'translate';

interface PipelineProgressEvent {
  status?: string;
  name?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

interface WhisperChunk {
  text?: string;
  timestamp?: [number | null, number | null];
}

interface WhisperOutput {
  text?: string;
  chunks?: WhisperChunk[];
}

interface TransformersCache {
  match(request: string | Request): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

export interface ActiveModelTranscriptionEngineOptions {
  modelManager: ModelManager;
  selectedModels?: ModelSelections;
  preferWebGpu?: boolean;
  whisperDtype?: WhisperDtype;
  multilingual?: boolean;
  language?: string;
  subtask?: WhisperTask;
  onLog?: (line: string) => void;
  onProgress?: (value: number | null) => void;
  onTranscriptUpdate?: (transcript: Transcript) => void;
}

let cachedPipeline: AutomaticSpeechRecognitionPipeline | null = null;
let cachedModel = '';
let cachedVersion = '';
let cachedDtype: WhisperDtype = 'q8';
let cachedDevice = '';

const STREAM_UPDATE_INTERVAL_MS = 150;
const DEFAULT_WHISPER_LANGUAGE = 'english';

export async function requireModelVersion(
  modelManager: ModelManager,
  model: ManagedModel,
  selectedVersion?: string,
): Promise<ModelVersionManifestEntry> {
  if (selectedVersion !== undefined && selectedVersion.length > 0) {
    const selectedModel = await modelManager.getVersion(model, selectedVersion);

    if (selectedModel === null) {
      throw new Error(
        `Selected ${model} model ${selectedVersion} is not available.`,
      );
    }

    return selectedModel.manifest;
  }

  const activeModel = await modelManager.getActiveVersion(model);

  if (activeModel === null) {
    throw new Error(`Download and activate a ${model} model first.`);
  }

  return activeModel.manifest;
}

export class ActiveModelTranscriptionEngine implements TranscriptionEngine {
  readonly #modelManager: ModelManager;
  readonly #selectedModels: ModelSelections;
  readonly #preferWebGpu: boolean;
  readonly #whisperDtype: WhisperDtype;
  readonly #multilingual: boolean;
  readonly #language?: string;
  readonly #subtask: WhisperTask;
  readonly #onLog: (line: string) => void;
  readonly #onProgress: (value: number | null) => void;
  readonly #onTranscriptUpdate: (transcript: Transcript) => void;

  constructor(options: ActiveModelTranscriptionEngineOptions) {
    this.#modelManager = options.modelManager;
    this.#selectedModels = options.selectedModels ?? {};
    this.#preferWebGpu = options.preferWebGpu ?? false;
    this.#whisperDtype = options.whisperDtype ?? 'q8';
    this.#multilingual = options.multilingual ?? true;
    this.#language = options.language ?? DEFAULT_WHISPER_LANGUAGE;
    this.#subtask = options.subtask ?? 'transcribe';
    this.#onLog = options.onLog ?? (() => undefined);
    this.#onProgress = options.onProgress ?? (() => undefined);
    this.#onTranscriptUpdate = options.onTranscriptUpdate ?? (() => undefined);
  }

  async transcribe(
    meeting: Meeting,
    options: {
      newline_callback?: (timeCode: string, line: string) => void;
    } = {},
  ): Promise<Transcript> {
    const manifest = await requireModelVersion(
      this.#modelManager,
      'whisper',
      this.#selectedModels.whisper,
    );
    const model = this.#resolveModelId(manifest);
    const transcriber = await this.#getTranscriber(model, manifest);
    const isDistilWhisper = model.startsWith('distil-whisper/');
    const audio = this.#normalizeAudio(meeting.audio);
    const output = await this.#runTranscriber(transcriber, audio, isDistilWhisper);

    const transcript = this.#toTranscript(
      Array.isArray(output) ? output[0] : output,
      audio.length / this.#getSamplingRate(transcriber),
    );

    this.#onProgress(null);
    this.#onTranscriptUpdate(transcript);
    this.#emitLines(transcript, options.newline_callback);

    return transcript;
  }

  async #runTranscriber(
    transcriber: AutomaticSpeechRecognitionPipeline,
    audio: Float32Array,
    isDistilWhisper: boolean,
  ): Promise<WhisperOutput | WhisperOutput[]> {
    const inferenceOptions = {
      top_k: 0,
      do_sample: false,
      chunk_length_s: isDistilWhisper ? 20 : 30,
      stride_length_s: isDistilWhisper ? 3 : 5,
      language: this.#language,
      task: this.#subtask,
      return_timestamps: true,
      force_full_sequences: false,
      streamer: this.#createStreamer(transcriber),
    } as Record<string, unknown>;

    try {
      const output = (await transcriber(
        audio,
        inferenceOptions,
      )) as WhisperOutput | WhisperOutput[];
      return output;
    } catch (error) {
      throw error;
    }
  }

  async #getTranscriber(
    model: string,
    manifest: ModelVersionManifestEntry,
  ): Promise<AutomaticSpeechRecognitionPipeline> {
    const device = this.#resolveDevice();

    if (
      cachedPipeline !== null &&
      cachedModel === model &&
      cachedVersion === manifest.version &&
      cachedDtype === this.#whisperDtype &&
      cachedDevice === device
    ) {
      return cachedPipeline;
    }

    if (cachedPipeline !== null) {
      cachedPipeline.dispose?.();
    }

    cachedModel = model;
    cachedVersion = manifest.version;
    cachedDtype = this.#whisperDtype;
    cachedDevice = device;
    this.#onLog(
      `[transcription] loading ${model} (${device}, ${this.#whisperDtype})`,
    );
    cachedPipeline = await this.#loadPipeline(
      model,
      manifest,
      this.#whisperDtype,
      device,
    );

    return cachedPipeline;
  }

  async #loadPipeline(
    model: string,
    manifest: ModelVersionManifestEntry,
    dtype: WhisperDtype,
    device: 'wasm' | 'webgpu',
  ): Promise<AutomaticSpeechRecognitionPipeline> {
    this.#assertWhisperFilesAvailable(manifest, dtype);
    this.#configureWasmThreads(device);
    this.#configureModelCache(model, manifest);
    return pipeline('automatic-speech-recognition', model, {
      dtype,
      device,
      local_files_only: true,
      progress_callback: (event: PipelineProgressEvent) =>
        this.#handleProgress(event),
      revision: model.includes('/whisper-medium') ? 'no_attentions' : 'main',
    } as Record<string, unknown>);
  }

  #assertWhisperFilesAvailable(
    manifest: ModelVersionManifestEntry,
    dtype: WhisperDtype,
  ): void {
    const requiredFiles =
      dtype === 'q8'
        ? [
            'onnx/encoder_model_quantized.onnx',
            'onnx/decoder_model_merged_quantized.onnx',
          ]
        : ['onnx/encoder_model.onnx', 'onnx/decoder_model_merged.onnx'];
    const availableFiles = new Set(manifest.files.map((file) => file.path));
    const missingFiles = requiredFiles.filter((file) => !availableFiles.has(file));

    if (missingFiles.length > 0) {
      throw new Error(
        `Selected Whisper version ${manifest.version} cannot run with ${dtype}. Missing ${missingFiles.join(', ')}. Remove it and download a matching fp32 preset.`,
      );
    }
  }

  #configureModelCache(
    model: string,
    manifest: ModelVersionManifestEntry,
  ): void {
    const fileEntries = new Map(
      manifest.files.map((file) => [file.path, file] as const),
    );
    const cache: TransformersCache = {
      match: async (request) => {
        const requestUrl = typeof request === 'string' ? request : request.url;
        const file = this.#getRequestedModelFile(
          requestUrl,
          model,
          fileEntries,
        );

        if (file === undefined) {
          return undefined;
        }

        const fileHandle = await this.#modelManager.getModelFile(
          manifest.model,
          manifest.version,
          file.path,
        );
        const blob = await fileHandle.getFile();
        const body = await blob.arrayBuffer();

        this.#assertValidCachedFile(file.path, body);
        this.#onLog(
          `[transcription] local model file: ${file.path} (${body.byteLength} bytes)`,
        );

        return new Response(body, {
          headers: {
            'content-length': String(blob.size),
            'content-type': file.type,
          },
        });
      },
      put: async () => undefined,
    };

    env.useCustomCache = true;
    env.customCache = cache;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.useBrowserCache = false;
    // Prevent cache misses from falling through to Vite's /models/* HTML route.
    env.localModelPath = 'https://notetaker.invalid/models/';
  }

  #assertValidCachedFile(filePath: string, body: ArrayBuffer): void {
    if (body.byteLength === 0) {
      throw new Error(`Model file ${filePath} is empty.`);
    }

    if (!filePath.endsWith('.onnx')) {
      return;
    }

    const header = new TextDecoder().decode(body.slice(0, 64)).toLowerCase();

    if (header.includes('<!doctype') || header.includes('<html')) {
      throw new Error(`Model file ${filePath} contains HTML, not ONNX data.`);
    }
  }

  #getRequestedModelFile(
    request: string,
    model: string,
    fileEntries: Map<string, ModelVersionManifestEntry['files'][number]>,
  ): ModelVersionManifestEntry['files'][number] | undefined {
    const normalizedRequest = decodeURIComponent(request).replaceAll('\\', '/');
    const modelMarker = `${model}/`;
    const modelIndex = normalizedRequest.indexOf(modelMarker);

    if (modelIndex === -1) {
      return undefined;
    }

    let requestedPath = normalizedRequest.slice(modelIndex + modelMarker.length);

    if (requestedPath.startsWith('resolve/main/')) {
      requestedPath = requestedPath.slice('resolve/main/'.length);
    } else if (requestedPath.startsWith('main/')) {
      requestedPath = requestedPath.slice('main/'.length);
    }

    return fileEntries.get(requestedPath.split('?')[0]);
  }

  #configureWasmThreads(device: 'wasm' | 'webgpu'): void {
    if (device !== 'wasm') {
      return;
    }

    const wasm = env.backends.onnx?.wasm;

    if (wasm === undefined) {
      return;
    }

    // Keep this single-threaded until ONNX Runtime Web inference is stable.
    // The threaded WASM path can fail with "invalid data location" for these
    // encoder/decoder graphs in some browser/runtime combinations.
    wasm.numThreads = 1;
  }

  #resolveDevice(): 'wasm' | 'webgpu' {
    // Whisper Web's fast path is WASM. WebGPU session creation can repeatedly
    // reinitialize for these encoder/decoder graphs in the current runtime.
    return 'wasm';
  }

  #createStreamer(
    transcriber: AutomaticSpeechRecognitionPipeline,
  ): WhisperTextStreamer {
    const completedSegments: TranscriptSegment[] = [];
    let currentStartSeconds: number | null = null;
    let currentText = '';
    let lastUpdateAt = 0;

    const emitUpdate = (includePartial: boolean, force = false) => {
      const now = Date.now();

      if (!force && now - lastUpdateAt < STREAM_UPDATE_INTERVAL_MS) {
        return;
      }

      lastUpdateAt = now;
      const partialText = currentText.trim();
      const segments = [...completedSegments];

      if (includePartial && partialText.length > 0) {
        const startSeconds =
          currentStartSeconds ?? completedSegments.at(-1)?.endSeconds ?? 0;
        segments.push({
          text: partialText,
          startSeconds,
          endSeconds: startSeconds,
        });
      }

      const transcript = this.#toTranscript({
        text: segments
          .map((segment) => segment.text)
          .join(' ')
          .trim(),
        chunks: segments.map((segment) => ({
          text: segment.text,
          timestamp: [segment.startSeconds, segment.endSeconds],
        })),
      });

      this.#onTranscriptUpdate(transcript);
    };

    return new WhisperTextStreamer(transcriber.tokenizer as never, {
      skip_prompt: true,
      skip_special_tokens: true,
      time_precision: this.#getTimePrecision(transcriber),
      callback_function: (text: string) => {
        if (currentStartSeconds === null) {
          currentStartSeconds = completedSegments.at(-1)?.endSeconds ?? 0;
        }

        currentText += text;
        emitUpdate(true);
      },
      on_chunk_start: (startSeconds: number) => {
        currentStartSeconds = startSeconds;
        currentText = '';
      },
      on_chunk_end: (endSeconds: number) => {
        const text = currentText.trim();

        if (text.length > 0) {
          const startSeconds =
            currentStartSeconds ?? completedSegments.at(-1)?.endSeconds ?? 0;
          completedSegments.push({
            text,
            startSeconds,
            endSeconds,
          });
        }

        currentStartSeconds = null;
        currentText = '';
        emitUpdate(false, true);
      },
      on_finalize: () => {
        const text = currentText.trim();

        if (text.length > 0) {
          const startSeconds =
            currentStartSeconds ?? completedSegments.at(-1)?.endSeconds ?? 0;
          completedSegments.push({
            text,
            startSeconds,
            endSeconds: startSeconds,
          });
        }

        currentStartSeconds = null;
        currentText = '';
        emitUpdate(false, true);
      },
    });
  }

  #resolveModelId(manifest: ModelVersionManifestEntry): string {
    const huggingFaceModelId = manifest.metadata?.['huggingFaceModelId'];

    if (
      typeof huggingFaceModelId === 'string' &&
      huggingFaceModelId.length > 0
    ) {
      if (
        huggingFaceModelId.startsWith('distil-whisper/') ||
        this.#multilingual
      ) {
        return huggingFaceModelId;
      }

      return `${huggingFaceModelId}.en`;
    }

    throw new Error(
      `Whisper model ${manifest.version} is missing a Hugging Face model id.`,
    );
  }

  #handleProgress(event: PipelineProgressEvent): void {
    if (typeof event.progress === 'number') {
      this.#onProgress(Math.max(0, Math.min(100, event.progress)));
    } else if (
      typeof event.loaded === 'number' &&
      typeof event.total === 'number' &&
      event.total > 0
    ) {
      this.#onProgress(
        Math.max(0, Math.min(100, (event.loaded / event.total) * 100)),
      );
    }

    const target = event.file ?? event.name;
    if (event.status !== undefined && target !== undefined) {
      this.#onLog(`[transcription] ${event.status}: ${target}`);
    }
  }

  #normalizeAudio(audio: Meeting['audio']): Float32Array {
    if (audio instanceof Float32Array) {
      return audio;
    }

    if (audio instanceof Uint8Array) {
      return new Float32Array(
        audio.buffer,
        audio.byteOffset,
        Math.floor(audio.byteLength / Float32Array.BYTES_PER_ELEMENT),
      );
    }

    if (audio instanceof ArrayBuffer) {
      return new Float32Array(audio);
    }

    throw new Error(
      'Transcription requires decoded Float32Array audio samples.',
    );
  }

  #getTimePrecision(transcriber: AutomaticSpeechRecognitionPipeline): number {
    const chunkLength =
      transcriber.processor?.feature_extractor?.config?.chunk_length;
    const maxSourcePositions =
      transcriber.model?.config?.max_source_positions ??
      transcriber.model?.config?.max_position_embeddings;

    if (
      chunkLength === undefined ||
      maxSourcePositions === undefined ||
      maxSourcePositions === 0
    ) {
      return 0.02;
    }

    return chunkLength / maxSourcePositions;
  }

  #getSamplingRate(transcriber: AutomaticSpeechRecognitionPipeline): number {
    return (
      transcriber.processor?.feature_extractor?.config?.sampling_rate ?? 16_000
    );
  }

  #toTranscript(
    output: WhisperOutput | undefined,
    durationSeconds = 0,
  ): Transcript {
    if (output === undefined) {
      return { text: '', segments: [] };
    }

    const segments = (output.chunks ?? [])
      .map((chunk): TranscriptSegment | null => {
        const [startSeconds, endSeconds] = chunk.timestamp ?? [null, null];
        const text = chunk.text?.trim() ?? '';

        if (text.length === 0 || startSeconds === null || endSeconds === null) {
          return null;
        }

        return { text, startSeconds, endSeconds };
      })
      .filter((segment): segment is TranscriptSegment => segment !== null);

    const text =
      output.text?.trim() ??
      segments
        .map((segment) => segment.text)
        .join(' ')
        .trim();

    return {
      text,
      segments:
        segments.length > 0 || text.length === 0
          ? segments
          : [
              {
                text,
                startSeconds: 0,
                endSeconds: Math.max(0, durationSeconds),
              },
            ],
    };
  }

  #emitLines(
    transcript: Transcript,
    newlineCallback?: (timeCode: string, line: string) => void,
  ): void {
    if (newlineCallback === undefined) {
      return;
    }

    for (const segment of transcript.segments) {
      newlineCallback(this.#formatTimeCode(segment.startSeconds), segment.text);
    }
  }

  #formatTimeCode(seconds: number): string {
    const safeSeconds = Math.max(0, seconds);
    const minutes = Math.floor(safeSeconds / 60);
    const remainingSeconds = Math.floor(safeSeconds % 60);

    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
}
