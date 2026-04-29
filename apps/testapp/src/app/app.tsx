import { useEffect, useRef, useState } from 'react';
import {
  AudioRecorder,
  type AudioRecordingResult,
} from '@notetaker/audio-recorder';
import {
  type EngineProgressEvent,
  type EngineStage,
  type MeetingNotes,
  type SpeakerTurn,
  type Transcript,
} from '@notetaker/engine';
import { FileSystem } from '@notetaker/filesystem';
import {
  ModelManager,
  type ManagedModel,
  type ModelVersionManifestEntry,
} from '@notetaker/model-manager';
import EngineWorker from './engine.worker.ts?worker';
import type {
  EngineWorkerRequest,
  EngineWorkerResponse,
} from './engine.worker';
import styles from './app.module.css';

interface StoredAudioFile {
  name: string;
  size: number;
  type: string;
  updatedAt: number;
  url: string;
  fileHandle: FileSystemFileHandle;
}

interface LiveTranscriptSegment {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

type RecorderStatus = 'idle' | 'ready' | 'recording' | 'saving' | 'error';
type EngineStatus = 'idle' | 'processing' | 'error';
type AppPage = 'models' | 'recordings' | 'transcription' | 'diarization' | 'engine';
type WebGpuSupport = 'checking' | 'supported' | 'unsupported';
type WhisperQuantization = 'fp32';
type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};
type NavigatorWithWebGpu = Navigator & {
  gpu?: {
    requestAdapter(): Promise<unknown>;
  };
};

interface ModelDownloadTarget {
  model: ManagedModel;
  label: string;
  description: string;
  defaultSearch: string;
}

interface HuggingFaceSibling {
  rfilename?: string;
}

interface HuggingFaceModel {
  id: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
  siblings?: HuggingFaceSibling[];
}

interface ModelSearchState {
  query: string;
  results: HuggingFaceModel[];
  selectedFiles: Record<string, string>;
  searching: boolean;
}

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
  files: DirectModelFile[];
}

interface DownloadProgressState {
  title: string;
  currentFile: string;
  fileIndex: number;
  fileCount: number;
  loadedBytes: number;
  totalBytes: number | null;
  status: 'downloading' | 'saving' | 'complete' | 'error';
}

type ModelSearchStates = Record<ManagedModel, ModelSearchState>;
type EngineModelSelections = Record<ManagedModel, string>;

const EMPTY_ENGINE_MODEL_SELECTIONS: EngineModelSelections = {
  whisper: '',
  pyannote: '',
  gemma4: '',
};

const MODEL_DOWNLOAD_TARGETS: ModelDownloadTarget[] = [
  {
    model: 'whisper',
    label: 'Whisper',
    description:
      'Transcription model. Searches Whisper and Faster-Whisper repositories.',
    defaultSearch: 'whisper',
  },
  {
    model: 'pyannote',
    label: 'Pyannote',
    description: 'Speaker diarization model',
    defaultSearch: 'pyannote speaker diarization',
  },
  {
    model: 'gemma4',
    label: 'Gemma 4',
    description:
      'Speaker naming model. Filters E2B, E4B, 31B, 26B, A4B with BF16, SFP8, or Q4_0.',
    defaultSearch: 'gemma',
  },
];

const GEMMA_SIZE_LABELS = ['e2b', 'e4b', '31b', '26b', 'a4b'] as const;
const GEMMA_QUANT_LABELS = ['bf16', 'sfp8', 'q4_0'] as const;
const MODEL_FILE_EXTENSIONS = [
  '.safetensors',
  '.gguf',
  '.onnx',
  '.bin',
  '.pt',
  '.pth',
] as const;

const WHISPER_ONNX_DOWNLOADS: DirectModelDownload[] = [
  createWhisperOnnxDownload(
    'onnx-community/whisper-tiny',
    'Tiny ONNX',
    'Current transformers.js ONNX tiny model.',
    {
      'added_tokens.json': 34604,
      'config.json': 2243,
      'generation_config.json': 3772,
      'merges.txt': 493869,
      'normalizer.json': 52666,
      'preprocessor_config.json': 339,
      'quantize_config.json': 10126,
      'special_tokens_map.json': 2194,
      'tokenizer.json': 2480466,
      'tokenizer_config.json': 282683,
      'vocab.json': 1036584,
      'onnx/encoder_model.onnx': 32904992,
      'onnx/decoder_model_merged.onnx': 118553827,
    },
  ),
  createWhisperOnnxDownload(
    'onnx-community/whisper-base',
    'Base ONNX',
    'Current transformers.js ONNX base model.',
    {
      'added_tokens.json': 34604,
      'config.json': 2243,
      'generation_config.json': 3832,
      'merges.txt': 493869,
      'normalizer.json': 52666,
      'preprocessor_config.json': 339,
      'quantize_config.json': 10126,
      'special_tokens_map.json': 2194,
      'tokenizer.json': 2480466,
      'tokenizer_config.json': 282682,
      'vocab.json': 1036584,
      'onnx/encoder_model.onnx': 82468078,
      'onnx/decoder_model_merged.onnx': 208521528,
    },
  ),
  createWhisperOnnxDownload(
    'onnx-community/whisper-small',
    'Small ONNX',
    'Current transformers.js ONNX small model.',
    {
      'added_tokens.json': 34604,
      'config.json': 2227,
      'generation_config.json': 3893,
      'merges.txt': 493869,
      'normalizer.json': 52666,
      'preprocessor_config.json': 339,
      'quantize_config.json': 10126,
      'special_tokens_map.json': 2194,
      'tokenizer.json': 2480466,
      'tokenizer_config.json': 282683,
      'vocab.json': 1036584,
      'onnx/encoder_model.onnx': 352825870,
      'onnx/decoder_model_merged.onnx': 615324301,
    },
  ),
];
const PYANNOTE_REPO = 'onnx-community/pyannote-segmentation-3.0';
const PYANNOTE_COMMON_FILES: [string, number][] = [
  ['config.json', 408],
  ['preprocessor_config.json', 158],
];

function createPyannoteDownload(
  label: string,
  description: string,
  onnxFile: string,
  onnxSize: number,
): DirectModelDownload {
  return {
    id: PYANNOTE_REPO,
    label,
    description,
    model: 'pyannote',
    files: ([...PYANNOTE_COMMON_FILES, [onnxFile, onnxSize]] as const).map(
      ([path, size]) => ({
        path,
        url: buildHuggingFaceDownloadUrl(PYANNOTE_REPO, path),
        type: path.endsWith('.onnx')
          ? 'application/octet-stream'
          : 'application/json',
        size,
      }),
    ),
  };
}

const PYANNOTE_DOWNLOADS: DirectModelDownload[] = [
  createPyannoteDownload(
    'Segmentation 3.0 FP32',
    'Full-precision ONNX segmentation model (~5.7 MB). Best accuracy.',
    'onnx/model.onnx',
    5986908,
  ),
  createPyannoteDownload(
    'Segmentation 3.0 Q8',
    'Quantized ONNX segmentation model (~1.5 MB). Same accuracy, 4× smaller.',
    'onnx/model_quantized.onnx',
    1542308,
  ),
  createPyannoteDownload(
    'Segmentation 3.0 INT8',
    'INT8-quantized ONNX segmentation model (~1.5 MB). Equivalent to Q8.',
    'onnx/model_int8.onnx',
    1542304,
  ),
];
const GEMMA_DOWNLOADS: DirectModelDownload[] = [
  createDirectModelDownload({
    id: 'google/gemma-4-E2B-it',
    label: 'Google E2B IT',
    description:
      'Official Google Gemma 4 E2B instruct BF16 safetensors preset.',
    model: 'gemma4',
    files: {
      'chat_template.jinja': 16317,
      'config.json': 4954,
      'generation_config.json': 208,
      'model.safetensors': 10246621918,
      'processor_config.json': 1689,
      'tokenizer.json': 32169626,
      'tokenizer_config.json': 2095,
    },
  }),
  createDirectModelDownload({
    id: 'google/gemma-4-E4B-it',
    label: 'Google E4B IT',
    description:
      'Official Google Gemma 4 E4B instruct BF16 safetensors preset.',
    model: 'gemma4',
    files: {
      'chat_template.jinja': 16317,
      'config.json': 5145,
      'generation_config.json': 208,
      'model.safetensors': 15992595884,
      'processor_config.json': 1689,
      'tokenizer.json': 32169626,
      'tokenizer_config.json': 2095,
    },
  }),
  createDirectModelDownload({
    id: 'google/gemma-4-26B-A4B-it',
    label: 'Google 26B A4B IT',
    description:
      'Official Google Gemma 4 26B/A4B instruct BF16 safetensors preset.',
    model: 'gemma4',
    files: {
      'chat_template.jinja': 16448,
      'config.json': 3815,
      'generation_config.json': 208,
      'model-00001-of-00002.safetensors': 49907246508,
      'model-00002-of-00002.safetensors': 1704763408,
      'model.safetensors.index.json': 103196,
      'processor_config.json': 1689,
      'tokenizer.json': 32169626,
      'tokenizer_config.json': 2095,
    },
  }),
  createDirectModelDownload({
    id: 'google/gemma-4-31B-it',
    label: 'Google 31B IT',
    description:
      'Official Google Gemma 4 31B instruct BF16 safetensors preset.',
    model: 'gemma4',
    files: {
      'chat_template.jinja': 16448,
      'config.json': 4621,
      'generation_config.json': 208,
      'model-00001-of-00002.safetensors': 49784788364,
      'model-00002-of-00002.safetensors': 12761549884,
      'model.safetensors.index.json': 120246,
      'processor_config.json': 1689,
      'tokenizer.json': 32169626,
      'tokenizer_config.json': 2095,
    },
  }),
  createDirectModelDownload({
    id: 'unsloth/gemma-4-E2B-it-GGUF',
    label: 'E2B Q4_0 GGUF',
    description:
      'Quantized Gemma 4 E2B instruct preset based on google/gemma-4-E2B-it.',
    model: 'gemma4',
    files: {
      'config.json': 5041,
      'gemma-4-E2B-it-Q4_0.gguf': 3041375904,
    },
  }),
  createDirectModelDownload({
    id: 'unsloth/gemma-4-E4B-it-GGUF',
    label: 'E4B Q4_0 GGUF',
    description:
      'Quantized Gemma 4 E4B instruct preset based on google/gemma-4-E4B-it.',
    model: 'gemma4',
    files: {
      'config.json': 5232,
      'gemma-4-E4B-it-Q4_0.gguf': 4836000448,
    },
  }),
  createDirectModelDownload({
    id: 'bartowski/google_gemma-4-26B-A4B-it-GGUF',
    label: '26B A4B Q4_0 GGUF',
    description:
      'Quantized Gemma 4 26B/A4B instruct preset based on google/gemma-4-26B-A4B-it.',
    model: 'gemma4',
    files: {
      'README.md': 14903,
      'google_gemma-4-26B-A4B-it-Q4_0.gguf': 14759382976,
    },
  }),
  createDirectModelDownload({
    id: 'unsloth/gemma-4-31B-it-GGUF',
    label: '31B Q4_0 GGUF',
    description:
      'Quantized Gemma 4 31B instruct preset based on google/gemma-4-31B-it.',
    model: 'gemma4',
    files: {
      'config.json': 4702,
      'gemma-4-31B-it-Q4_0.gguf': 17338245664,
    },
  }),
  createDirectModelDownload({
    id: 'onnx-community/gemma-4-E2B-it-ONNX',
    label: 'E2B Q4 ONNX',
    description:
      'Quantized ONNX text-generation files for browser/WebGPU testing.',
    model: 'gemma4',
    files: {
      'chat_template.jinja': 16317,
      'config.json': 5549,
      'generation_config.json': 238,
      'onnx/decoder_model_merged_q4.onnx': 647599,
      'onnx/decoder_model_merged_q4.onnx_data': 1864102912,
      'onnx/embed_tokens_q4.onnx': 5142,
      'onnx/embed_tokens_q4.onnx_data': 1762656256,
      'processor_config.json': 1689,
      'tokenizer.json': 19439251,
      'tokenizer_config.json': 18807,
    },
  }),
];

const INITIAL_MODEL_SEARCHES: ModelSearchStates = {
  whisper: {
    query: 'whisper',
    results: [],
    selectedFiles: {},
    searching: false,
  },
  pyannote: {
    query: 'pyannote speaker diarization',
    results: [],
    selectedFiles: {},
    searching: false,
  },
  gemma4: {
    query: 'gemma',
    results: [],
    selectedFiles: {},
    searching: false,
  },
};

function isFileHandle(
  handle: FileSystemHandle,
): handle is FileSystemFileHandle {
  return handle.kind === 'file';
}

const fileSystem = new FileSystem();

const WHISPER_SAMPLE_RATE = 16_000;

async function decodeAudioBlobToMonoFloat32(
  blob: Blob,
  targetSampleRate: number,
): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const decodeContext = new AudioContext();

  try {
    const decoded = await decodeContext.decodeAudioData(arrayBuffer.slice(0));
    const frameCount = Math.ceil(decoded.duration * targetSampleRate);
    if (!Number.isFinite(decoded.duration) || frameCount <= 0) {
      throw new Error(
        `Decoded audio is empty (${formatBytes(blob.size)} source file).`,
      );
    }

    const offlineContext = new OfflineAudioContext(
      1,
      frameCount,
      targetSampleRate,
    );
    const source = offlineContext.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineContext.destination);
    source.start();
    const rendered = await offlineContext.startRendering();
    const samples = rendered.getChannelData(0).slice();
    if (samples.length === 0) {
      throw new Error(
        `Resampled audio is empty (${decoded.duration.toFixed(3)}s decoded duration).`,
      );
    }

    return samples;
  } finally {
    void decodeContext.close();
  }
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatOptionalBytes(size: number | null | undefined): string {
  if (size === undefined) {
    return 'Checking size...';
  }

  if (size === null) {
    return 'Size unavailable';
  }

  return formatBytes(size);
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
}

function formatTimestamp(totalSeconds: number): string {
  const safeSeconds = Number.isFinite(totalSeconds)
    ? Math.max(0, totalSeconds)
    : 0;
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = Math.floor(safeSeconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function createWhisperOnnxDownload(
  repositoryId: string,
  label: string,
  description: string,
  fileSizes: Record<string, number>,
): DirectModelDownload {
  return {
    id: repositoryId,
    label,
    description,
    model: 'whisper',
    files: Object.entries(fileSizes).map(([path, size]) => ({
      path,
      url: buildHuggingFaceDownloadUrl(repositoryId, path),
      type: path.endsWith('.onnx')
        ? 'application/octet-stream'
        : 'application/json',
      size,
    })),
  };
}

function createDirectModelDownload(options: {
  id: string;
  label: string;
  description: string;
  model: ManagedModel;
  files: Record<string, number>;
}): DirectModelDownload {
  return {
    id: options.id,
    label: options.label,
    description: options.description,
    model: options.model,
    files: Object.entries(options.files).map(([path, size]) => ({
      path,
      url: buildHuggingFaceDownloadUrl(options.id, path),
      type: resolveModelFileType(path),
      size,
    })),
  };
}

function resolveModelFileType(path: string): string {
  if (path.endsWith('.json')) {
    return 'application/json';
  }

  if (path.endsWith('.yaml') || path.endsWith('.yml')) {
    return 'application/yaml';
  }

  if (path.endsWith('.md') || path.endsWith('.jinja')) {
    return 'text/plain';
  }

  return 'application/octet-stream';
}

async function getRemoteFileSize(url: string): Promise<number | null> {
  const response = await fetch(url, { method: 'HEAD' });

  if (!response.ok) {
    return null;
  }

  const size = Number(response.headers.get('content-length'));
  return Number.isFinite(size) ? size : null;
}

async function downloadBlobWithProgress(
  file: DirectModelFile,
  onProgress: (loadedBytes: number, totalBytes: number | null) => void,
): Promise<Blob> {
  const response = await fetch(file.url);

  if (!response.ok) {
    throw new Error(
      `Download failed for ${file.path} with ${response.status} ${response.statusText}.`,
    );
  }

  const totalBytes = Number(response.headers.get('content-length'));
  const normalizedTotalBytes = Number.isFinite(totalBytes) ? totalBytes : null;

  if (response.body === null) {
    const blob = await response.blob();
    onProgress(blob.size, normalizedTotalBytes ?? blob.size);
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let loadedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    chunks.push(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
    loadedBytes += value.byteLength;
    onProgress(loadedBytes, normalizedTotalBytes);
  }

  return new Blob(chunks, { type: file.type });
}

function getModelSearchText(model: HuggingFaceModel): string {
  return [model.id, ...(model.tags ?? [])].join(' ').toLowerCase();
}

function supportsTargetModel(
  model: ManagedModel,
  huggingFaceModel: HuggingFaceModel,
): boolean {
  const text = getModelSearchText(huggingFaceModel);

  if (model === 'whisper') {
    return (
      text.includes('whisper') ||
      text.includes('faster-whisper') ||
      text.includes('fast-whisper')
    );
  }

  if (model === 'pyannote') {
    return text.includes('pyannote') || text.includes('diarization');
  }

  return (
    text.includes('gemma') &&
    GEMMA_SIZE_LABELS.some((label) => text.includes(label)) &&
    GEMMA_QUANT_LABELS.some((label) => text.includes(label))
  );
}

function getDownloadableFiles(model: HuggingFaceModel): string[] {
  return (model.siblings ?? [])
    .map((sibling) => sibling.rfilename)
    .filter((fileName): fileName is string => fileName !== undefined)
    .filter((fileName) => {
      const lowerFileName = fileName.toLowerCase();
      return (
        !lowerFileName.startsWith('.') &&
        MODEL_FILE_EXTENSIONS.some((extension) =>
          lowerFileName.endsWith(extension),
        )
      );
    })
    .sort((first, second) => first.localeCompare(second));
}

function buildHuggingFaceDownloadUrl(
  modelId: string,
  fileName: string,
): string {
  return `https://huggingface.co/${modelId}/resolve/main/${fileName
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

async function searchHuggingFaceModels(
  target: ModelDownloadTarget,
  query: string,
): Promise<HuggingFaceModel[]> {
  const queries =
    target.model === 'whisper'
      ? [query, 'faster-whisper', 'fast-whisper']
      : [query];
  const models = new Map<string, HuggingFaceModel>();

  for (const searchQuery of queries) {
    const params = new URLSearchParams({
      search: searchQuery,
      limit: '20',
      full: 'true',
      sort: 'downloads',
      direction: '-1',
    });
    const response = await fetch(
      `https://huggingface.co/api/models?${params.toString()}`,
    );

    if (!response.ok) {
      throw new Error(
        `Hugging Face search failed with ${response.status} ${response.statusText}.`,
      );
    }

    const results = (await response.json()) as HuggingFaceModel[];
    for (const model of results) {
      if (
        supportsTargetModel(target.model, model) &&
        getDownloadableFiles(model).length > 0
      ) {
        models.set(model.id, model);
      }
    }
  }

  return [...models.values()].slice(0, 8);
}

async function loadStoredAudioFiles(
  directoryHandle: FileSystemDirectoryHandle,
): Promise<StoredAudioFile[]> {
  const files: StoredAudioFile[] = [];

  const iterableDirectoryHandle = directoryHandle as IterableDirectoryHandle;

  for await (const [name, handle] of iterableDirectoryHandle.entries()) {
    if (!isFileHandle(handle)) {
      continue;
    }

    const file = await handle.getFile();
    files.push({
      name,
      size: file.size,
      type: file.type || 'audio file',
      updatedAt: file.lastModified,
      url: URL.createObjectURL(file),
      fileHandle: handle,
    });
  }

  return files.sort((first, second) => second.updatedAt - first.updatedAt);
}

async function detectWebGpuSupport(): Promise<boolean> {
  const gpu = (navigator as NavigatorWithWebGpu).gpu;

  if (gpu === undefined) {
    return false;
  }

  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

function getWebGpuSupportLabel(support: WebGpuSupport): string {
  if (support === 'checking') {
    return 'Checking WebGPU...';
  }

  return support === 'supported' ? 'WebGPU available' : 'WASM fallback';
}

function getWhisperRuntimeLabel(
  support: WebGpuSupport,
  quantization: WhisperQuantization,
): string {
  return 'fp32 runs on WASM for the current Whisper runtime.';
}

function useObjectUrlCleanup(files: StoredAudioFile[]): void {
  useEffect(() => {
    return () => {
      for (const file of files) {
        URL.revokeObjectURL(file.url);
      }
    };
  }, [files]);
}

export function App() {
  const recorderRef = useRef<AudioRecorder | null>(null);
  const directoryHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
  const modelManagerRef = useRef<ModelManager | null>(null);
  const engineWorkerRef = useRef<Worker | null>(null);
  const engineRequestIdRef = useRef(0);
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [engineStatus, setEngineStatus] = useState<EngineStatus>('idle');
  const [message, setMessage] = useState('Opening OPFS audio-files folder...');
  const [modelMessage, setModelMessage] = useState(
    'Opening OPFS models folder...',
  );
  const [engineMessage, setEngineMessage] = useState(
    'Select a recording and run the engine.',
  );
  const [files, setFiles] = useState<StoredAudioFile[]>([]);
  const [lastRecording, setLastRecording] =
    useState<AudioRecordingResult | null>(null);
  const [modelSearches, setModelSearches] = useState<ModelSearchStates>(
    INITIAL_MODEL_SEARCHES,
  );
  const [modelVersions, setModelVersions] = useState<
    ModelVersionManifestEntry[]
  >([]);
  const [downloadingModel, setDownloadingModel] = useState<ManagedModel | null>(
    null,
  );
  const [selectedAudioName, setSelectedAudioName] = useState('');
  const [selectedEngineModels, setSelectedEngineModels] =
    useState<EngineModelSelections>(EMPTY_ENGINE_MODEL_SELECTIONS);
  const [meetingNotes, setMeetingNotes] = useState<MeetingNotes | null>(null);
  const [transcriptionResult, setTranscriptionResult] =
    useState<Transcript | null>(null);
  const [diarizationResult, setDiarizationResult] =
    useState<SpeakerTurn[] | null>(null);
  const [numSpeakersHint, setNumSpeakersHint] = useState<number | null>(null);
  const [engineDialogOpen, setEngineDialogOpen] = useState(false);
  const [engineDialogMode, setEngineDialogMode] = useState<
    'engine' | 'transcription'
  >('engine');
  const [engineLog, setEngineLog] = useState<string[]>([]);
  const [liveTranscriptSegments, setLiveTranscriptSegments] = useState<
    LiveTranscriptSegment[]
  >([]);
  const [engineBarValue, setEngineBarValue] = useState<number | null>(null);
  const [webGpuSupport, setWebGpuSupport] = useState<WebGpuSupport>('checking');
  const [whisperQuantization, setWhisperQuantization] =
    useState<WhisperQuantization>('fp32');
  const engineLogRef = useRef<HTMLDivElement | null>(null);
  const [engineProgress, setEngineProgress] = useState<
    Record<EngineStage, EngineProgressEvent['status'] | undefined>
  >({
    transcription: undefined,
    diarization: undefined,
    'speaker-naming': undefined,
  });
  const [activePage, setActivePage] = useState<AppPage>('models');
  const [remoteFileSizes, setRemoteFileSizes] = useState<
    Record<string, number | null>
  >({});
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgressState | null>(null);

  useObjectUrlCleanup(files);

  useEffect(() => {
    if (!engineDialogOpen) {
      return;
    }

    const node = engineLogRef.current;

    if (node !== null) {
      node.scrollTop = node.scrollHeight;
    }
  }, [engineDialogOpen, engineLog]);

  useEffect(() => {
    setSelectedEngineModels((current) => {
      let changed = false;
      const nextSelections: EngineModelSelections = { ...current };

      for (const target of MODEL_DOWNLOAD_TARGETS) {
        const versions = modelVersions.filter(
          (version) => version.model === target.model,
        );
        const currentSelection = current[target.model];
        const hasCurrentSelection = versions.some(
          (version) => version.version === currentSelection,
        );
        const fallbackSelection =
          versions.find((version) => version.active)?.version ??
          versions[0]?.version ??
          '';
        const nextSelection = hasCurrentSelection
          ? currentSelection
          : fallbackSelection;

        if (nextSelection !== currentSelection) {
          changed = true;
          nextSelections[target.model] = nextSelection;
        }
      }

      return changed ? nextSelections : current;
    });
  }, [modelVersions]);

  async function refreshFiles(directoryHandle = directoryHandleRef.current) {
    if (directoryHandle === null) {
      return;
    }

    const storedFiles = await loadStoredAudioFiles(directoryHandle);
    setFiles(storedFiles);

    if (selectedAudioName.length === 0 && storedFiles[0] !== undefined) {
      setSelectedAudioName(storedFiles[0].name);
    }
  }

  async function refreshModelVersions(modelManager = modelManagerRef.current) {
    if (modelManager === null) {
      return;
    }

    setModelVersions(await modelManager.listVersions());
  }

  function getKnownFileSize(url: string): number | null | undefined {
    return remoteFileSizes[url];
  }

function getKnownDownloadSize(download: DirectModelDownload): number {
  return download.files.reduce((total, file) => total + file.size, 0);
}

function getModelVersionTitle(version: ModelVersionManifestEntry): string {
  const title = version.metadata?.['title'];
  const huggingFaceModelId = version.metadata?.['huggingFaceModelId'];
  const huggingFaceFile = version.metadata?.['huggingFaceFile'];

  if (typeof title === 'string' && title.length > 0) {
    return title;
  }

  if (typeof huggingFaceModelId === 'string' && huggingFaceModelId.length > 0) {
    return typeof huggingFaceFile === 'string' && huggingFaceFile.length > 0
      ? `${huggingFaceModelId} / ${huggingFaceFile}`
      : huggingFaceModelId;
  }

  return version.version;
}

function getModelVersionDetail(version: ModelVersionManifestEntry): string {
  const size = version.files.reduce((total, file) => total + file.size, 0);
  return `${version.version} | ${formatBytes(size)}`;
}

function getDirectDownloadKey(download: DirectModelDownload): string {
  return `${download.model}-${download.id}-${download.label}`;
}

function getDirectDownloadVersion(
  download: DirectModelDownload,
  versions = modelVersions,
): ModelVersionManifestEntry | undefined {
  const sourceUrls = download.files.map((file) => file.url);

  return versions.find((version) => {
    const metadata = version.metadata ?? {};
    const storedSourceUrls = metadata['sourceUrls'];

    return (
      version.model === download.model &&
      metadata['huggingFaceModelId'] === download.id &&
      Array.isArray(storedSourceUrls) &&
      sourceUrls.length === storedSourceUrls.length &&
      sourceUrls.every((url) => storedSourceUrls.includes(url))
    );
  });
}

function getSearchDownloadVersion(
  model: ManagedModel,
  huggingFaceModelId: string,
  fileName: string,
  versions = modelVersions,
): ModelVersionManifestEntry | undefined {
  return versions.find(
    (version) =>
      version.model === model &&
      version.metadata?.['huggingFaceModelId'] === huggingFaceModelId &&
      version.metadata?.['huggingFaceFile'] === fileName,
  );
}

  function ensureRemoteFileSizes(urls: string[]) {
    const unknownUrls = urls.filter((url) => !(url in remoteFileSizes));

    for (const url of unknownUrls) {
      void getRemoteFileSize(url).then((size) => {
        setRemoteFileSizes((currentSizes) => ({
          ...currentSizes,
          [url]: size,
        }));
      });
    }
  }

  useEffect(() => {
    let isMounted = true;

    void detectWebGpuSupport().then((supported) => {
      if (isMounted) {
        setWebGpuSupport(supported ? 'supported' : 'unsupported');
      }
    });

    async function setupRecorder() {
      try {
        const directoryHandle = await fileSystem.getAudioFilesDir();
        const modelManager = await ModelManager.create(fileSystem);

        if (!isMounted) {
          return;
        }

        directoryHandleRef.current = directoryHandle;
        modelManagerRef.current = modelManager;
        recorderRef.current = new AudioRecorder(directoryHandle);
        await refreshFiles(directoryHandle);
        await refreshModelVersions(modelManager);
        setStatus('ready');
        setMessage('Ready. Recordings will be saved to OPFS/audio-files.');
        setModelMessage(
          'Ready. Search Hugging Face and cache model files in OPFS/models.',
        );
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setStatus('error');
        setMessage(
          error instanceof Error
            ? error.message
            : 'Failed to open OPFS audio-files folder.',
        );
        setModelMessage(
          error instanceof Error
            ? error.message
            : 'Failed to open OPFS models folder.',
        );
      }
    }

    void setupRecorder();

    return () => {
      isMounted = false;
      recorderRef.current?.cancel();
      engineWorkerRef.current?.terminate();
      engineWorkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (activePage !== 'models') {
      return;
    }

    const selectedUrls = MODEL_DOWNLOAD_TARGETS.flatMap((target) =>
      modelSearches[target.model].results.flatMap((result) => {
        const selectedFile =
          modelSearches[target.model].selectedFiles[result.id];
        return selectedFile === undefined
          ? []
          : [buildHuggingFaceDownloadUrl(result.id, selectedFile)];
      }),
    );

    ensureRemoteFileSizes(selectedUrls);
  }, [activePage, modelSearches, remoteFileSizes]);

  async function handleStartRecording() {
    const recorder = recorderRef.current;
    if (recorder === null) {
      return;
    }

    try {
      setMessage('Requesting microphone access...');
      await recorder.start();
      setStatus('recording');
      setMessage(
        'Recording. Stop to persist the audio file in OPFS/audio-files.',
      );
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error ? error.message : 'Failed to start recording.',
      );
    }
  }

  async function handleStopRecording() {
    const recorder = recorderRef.current;
    if (recorder === null) {
      return;
    }

    try {
      setStatus('saving');
      setMessage('Saving recording to OPFS/audio-files...');
      const recording = await recorder.stop();
      setLastRecording(recording);
      await refreshFiles();
      setStatus('ready');
      setMessage(`Saved ${recording.fileName} to OPFS/audio-files.`);
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error ? error.message : 'Failed to save recording.',
      );
    }
  }

  async function handleUploadRecordings(filesToUpload: FileList | null) {
    const directoryHandle = directoryHandleRef.current;

    if (
      directoryHandle === null ||
      filesToUpload === null ||
      filesToUpload.length === 0
    ) {
      return;
    }

    try {
      setStatus('saving');
      setMessage(
        `Importing ${filesToUpload.length} audio file${filesToUpload.length === 1 ? '' : 's'}...`,
      );

      for (const file of Array.from(filesToUpload)) {
        const fileHandle = await directoryHandle.getFileHandle(file.name, {
          create: true,
        });
        const writable = await fileHandle.createWritable();

        try {
          await writable.write(file);
          await writable.close();
        } catch (error) {
          await writable.abort();
          throw error;
        }
      }

      await refreshFiles(directoryHandle);
      setStatus('ready');
      setMessage(
        `Imported ${filesToUpload.length} audio file${filesToUpload.length === 1 ? '' : 's'} into OPFS/audio-files.`,
      );
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error
          ? error.message
          : 'Failed to import audio files.',
      );
    }
  }

  function handleCancelRecording() {
    recorderRef.current?.cancel();
    setStatus('ready');
    setMessage('Recording canceled. No audio file was stored.');
  }

  function updateModelSearch(
    model: ManagedModel,
    update: Partial<ModelSearchState>,
  ) {
    setModelSearches((currentSearches) => ({
      ...currentSearches,
      [model]: {
        ...currentSearches[model],
        ...update,
      },
    }));
  }

  function handleModelQueryChange(model: ManagedModel, query: string) {
    updateModelSearch(model, { query });
  }

  function handleSelectedModelFileChange(
    model: ManagedModel,
    modelId: string,
    fileName: string,
  ) {
    updateModelSearch(model, {
      selectedFiles: {
        ...modelSearches[model].selectedFiles,
        [modelId]: fileName,
      },
    });
  }

  async function handleSearchModels(target: ModelDownloadTarget) {
    const query =
      modelSearches[target.model].query.trim() || target.defaultSearch;

    try {
      updateModelSearch(target.model, { searching: true });
      setModelMessage(`Searching Hugging Face for ${target.label}...`);

      const results = await searchHuggingFaceModels(target, query);
      const selectedFiles = Object.fromEntries(
        results.map((result) => [
          result.id,
          getDownloadableFiles(result)[0] ?? '',
        ]),
      );

      updateModelSearch(target.model, {
        results,
        selectedFiles,
        searching: false,
      });
      setModelMessage(
        results.length === 0
          ? `No compatible ${target.label} models found.`
          : `Found ${results.length} compatible ${target.label} model${results.length === 1 ? '' : 's'}.`,
      );
    } catch (error) {
      updateModelSearch(target.model, { searching: false });
      setModelMessage(
        error instanceof Error
          ? error.message
          : `Failed to search ${target.label}.`,
      );
    }
  }

  async function handleDownloadModel(
    target: ModelDownloadTarget,
    huggingFaceModel: HuggingFaceModel,
  ) {
    const modelManager = modelManagerRef.current;
    const fileName =
      modelSearches[target.model].selectedFiles[huggingFaceModel.id];

    if (
      modelManager === null ||
      fileName === undefined ||
      fileName.length === 0
    ) {
      setModelMessage('Select a model file first.');
      return;
    }

    try {
      setDownloadingModel(target.model);
      setModelMessage(
        `Downloading ${target.label} from ${huggingFaceModel.id}...`,
      );

      const url = buildHuggingFaceDownloadUrl(huggingFaceModel.id, fileName);
      const directFile: DirectModelFile = {
        path: fileName,
        url,
        type: resolveModelFileType(fileName),
        size: getKnownFileSize(url) ?? 0,
      };
      setDownloadProgress({
        title: `Downloading ${target.label}`,
        currentFile: fileName,
        fileIndex: 1,
        fileCount: 1,
        loadedBytes: 0,
        totalBytes: getKnownFileSize(url) ?? null,
        status: 'downloading',
      });
      const file = await downloadBlobWithProgress(
        directFile,
        (loadedBytes, totalBytes) => {
          setDownloadProgress({
            title: `Downloading ${target.label}`,
            currentFile: fileName,
            fileIndex: 1,
            fileCount: 1,
            loadedBytes,
            totalBytes,
            status: 'downloading',
          });
        },
      );
      const version = `${huggingFaceModel.id.replaceAll('/', '__')}--${new Date()
        .toISOString()
        .replaceAll(':', '-')}`;

      setDownloadProgress((currentProgress) =>
        currentProgress === null
          ? null
          : { ...currentProgress, status: 'saving' },
      );

      await modelManager.addVersion({
        model: target.model,
        version,
        activate: true,
        files: [
          {
            path: fileName,
            data: file,
            type: file.type || 'application/octet-stream',
          },
        ],
        metadata: {
          title: `${huggingFaceModel.id} / ${fileName}`,
          huggingFaceModelId: huggingFaceModel.id,
          huggingFaceFile: fileName,
          sourceUrl: url,
        },
      });

      await refreshModelVersions(modelManager);
      setDownloadProgress((currentProgress) =>
        currentProgress === null
          ? null
          : { ...currentProgress, status: 'complete' },
      );
      setModelMessage(`Downloaded and activated ${target.label} ${version}.`);
    } catch (error) {
      setDownloadProgress((currentProgress) =>
        currentProgress === null
          ? null
          : { ...currentProgress, status: 'error' },
      );
      setModelMessage(
        error instanceof Error
          ? error.message
          : `Failed to download ${target.label}.`,
      );
    } finally {
      setDownloadingModel(null);
    }
  }

  async function handleDownloadDirectModel(download: DirectModelDownload) {
    const modelManager = modelManagerRef.current;

    if (modelManager === null) {
      setModelMessage('Models folder is not ready yet.');
      return;
    }

    try {
      setDownloadingModel(download.model);
      setModelMessage(`Downloading ${download.label} from ${download.id}...`);

      const files = [];
      const knownTotalBytes = getKnownDownloadSize(download);
      let completedBytes = 0;

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

        const blob = await downloadBlobWithProgress(
          file,
          (loadedBytes, fileTotalBytes) => {
            const fallbackTotalBytes =
              knownTotalBytes ??
              completedBytes + (fileTotalBytes ?? loadedBytes);
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

        completedBytes += blob.size;

        files.push({
          path: file.path,
          data: blob,
          type: file.type,
        });
      }

      const version = `${download.id.replaceAll('/', '__')}--direct--${new Date()
        .toISOString()
        .replaceAll(':', '-')}`;

      setDownloadProgress((currentProgress) =>
        currentProgress === null
          ? null
          : { ...currentProgress, status: 'saving' },
      );

      await modelManager.addVersion({
        model: download.model,
        version,
        activate: true,
        files,
        metadata: {
          title: download.label,
          format: download.model === 'gemma4' ? 'direct-hugging-face' : 'onnx',
          huggingFaceModelId: download.id,
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
      setDownloadProgress((currentProgress) =>
        currentProgress === null
          ? null
          : { ...currentProgress, status: 'error' },
      );
      setModelMessage(
        error instanceof Error
          ? error.message
          : `Failed to download ${download.label}.`,
      );
    } finally {
      setDownloadingModel(null);
    }
  }

  async function handleRemoveModelVersion(
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

  function getEngineWorker(): Worker {
    if (engineWorkerRef.current === null) {
      engineWorkerRef.current = new EngineWorker();
    }

    return engineWorkerRef.current;
  }

  async function handleRunEngine() {
    const selectedFile = files.find((file) => file.name === selectedAudioName);
    const missingModel = MODEL_DOWNLOAD_TARGETS.find(
      (target) => selectedEngineModels[target.model].length === 0,
    );

    if (selectedFile === undefined) {
      setEngineMessage('Select a stored recording first.');
      return;
    }

    if (missingModel !== undefined) {
      setEngineMessage(`Download a ${missingModel.label} model first.`);
      return;
    }

    setEngineStatus('processing');
    setEngineMessage(`Processing ${selectedFile.name}...`);
    setEngineDialogMode('engine');
    setEngineDialogOpen(true);
    setEngineLog([`Starting transcription of ${selectedFile.name}.`]);
    setLiveTranscriptSegments([]);
    setEngineBarValue(null);
    setEngineProgress({
      transcription: undefined,
      diarization: undefined,
      'speaker-naming': undefined,
    });

    try {
      const audioFile = await selectedFile.fileHandle.getFile();
      setEngineMessage(`Decoding ${selectedFile.name}...`);
      setEngineLog((current) => [
        ...current,
        `Decoding ${selectedFile.name} (${formatBytes(audioFile.size)})...`,
      ]);
      const samples = await decodeAudioBlobToMonoFloat32(
        audioFile,
        WHISPER_SAMPLE_RATE,
      );
      setEngineLog((current) => [
        ...current,
        `Decoded ${(samples.length / WHISPER_SAMPLE_RATE).toFixed(1)}s of audio.`,
        `Runtime: ${getWhisperRuntimeLabel(webGpuSupport, whisperQuantization)}`,
        'Whisper precision: fp32.',
        `Using Whisper ${selectedEngineModels.whisper}.`,
        `Using Pyannote ${selectedEngineModels.pyannote}.`,
        `Using Gemma 4 ${selectedEngineModels.gemma4}.`,
      ]);
      setEngineMessage(`Processing ${selectedFile.name}...`);
      const worker = getEngineWorker();
      const requestId = ++engineRequestIdRef.current;

      const notes = await new Promise<MeetingNotes>((resolve, reject) => {
        const handleMessage = (event: MessageEvent<EngineWorkerResponse>) => {
          const msg = event.data;

          if (msg.id !== requestId) {
            return;
          }

          if (msg.type === 'progress') {
            const { stage, status } = msg.event;
            setEngineProgress((current) => ({ ...current, [stage]: status }));
            setEngineLog((current) => [...current, `[${stage}] ${status}`]);
            return;
          }

          if (msg.type === 'log') {
            setEngineLog((current) => [...current, msg.line]);
            return;
          }

          if (msg.type === 'bar') {
            setEngineBarValue(msg.value);
            return;
          }

          if (msg.type === 'live-transcript') {
            setLiveTranscriptSegments(msg.segments);
            return;
          }

          worker.removeEventListener('message', handleMessage);

          if (msg.ok) {
            if (msg.mode !== 'engine') {
              reject(
                new Error(
                  'Worker returned an unexpected transcription result.',
                ),
              );
              return;
            }

            setLiveTranscriptSegments(msg.notes.transcript.segments);
            resolve(msg.notes);
          } else {
            reject(new Error(msg.error));
          }
        };

        worker.addEventListener('message', handleMessage);
        const request: EngineWorkerRequest = {
          id: requestId,
          fileName: selectedFile.name,
          audio: samples,
          selectedModels: selectedEngineModels,
          useWebGpu: webGpuSupport === 'supported',
          whisperDtype: whisperQuantization,
        };
        worker.postMessage(request, [samples.buffer]);
      });

      setMeetingNotes(notes);
      setEngineStatus('idle');
      setEngineMessage(`Engine completed for ${selectedFile.name}.`);
    } catch (error) {
      setEngineStatus('error');
      setEngineMessage(
        error instanceof Error ? error.message : 'Engine processing failed.',
      );
    }
  }

  async function handleRunTranscription() {
    const selectedFile = files.find((file) => file.name === selectedAudioName);

    if (selectedFile === undefined) {
      setEngineMessage('Select a stored recording first.');
      return;
    }

    if (selectedEngineModels.whisper.length === 0) {
      setEngineMessage('Download a Whisper model first.');
      return;
    }

    setEngineStatus('processing');
    setEngineMessage(`Transcribing ${selectedFile.name}...`);
    setEngineDialogMode('transcription');
    setEngineDialogOpen(true);
    setEngineLog([`Starting transcription-only run for ${selectedFile.name}.`]);
    setLiveTranscriptSegments([]);
    setEngineBarValue(null);
    setEngineProgress({
      transcription: undefined,
      diarization: undefined,
      'speaker-naming': undefined,
    });
    setTranscriptionResult(null);

    try {
      const audioFile = await selectedFile.fileHandle.getFile();
      setEngineMessage(`Decoding ${selectedFile.name}...`);
      setEngineLog((current) => [
        ...current,
        `Decoding ${selectedFile.name} (${formatBytes(audioFile.size)})...`,
      ]);
      const samples = await decodeAudioBlobToMonoFloat32(
        audioFile,
        WHISPER_SAMPLE_RATE,
      );
      setEngineLog((current) => [
        ...current,
        `Decoded ${(samples.length / WHISPER_SAMPLE_RATE).toFixed(1)}s of audio.`,
        `Runtime: ${getWhisperRuntimeLabel(webGpuSupport, whisperQuantization)}`,
        'Whisper precision: fp32.',
        `Using Whisper ${selectedEngineModels.whisper}.`,
      ]);
      setEngineMessage(`Transcribing ${selectedFile.name}...`);
      const worker = getEngineWorker();
      const requestId = ++engineRequestIdRef.current;

      const transcript = await new Promise<Transcript>((resolve, reject) => {
        const handleMessage = (event: MessageEvent<EngineWorkerResponse>) => {
          const msg = event.data;

          if (msg.id !== requestId) {
            return;
          }

          if (msg.type === 'progress') {
            const { stage, status } = msg.event;
            setEngineProgress((current) => ({ ...current, [stage]: status }));
            setEngineLog((current) => [...current, `[${stage}] ${status}`]);
            return;
          }

          if (msg.type === 'log') {
            setEngineLog((current) => [...current, msg.line]);
            return;
          }

          if (msg.type === 'bar') {
            setEngineBarValue(msg.value);
            return;
          }

          if (msg.type === 'live-transcript') {
            setLiveTranscriptSegments(msg.segments);
            return;
          }

          worker.removeEventListener('message', handleMessage);

          if (msg.ok) {
            if (msg.mode !== 'transcription') {
              reject(new Error('Worker returned an unexpected engine result.'));
              return;
            }

            setLiveTranscriptSegments(msg.transcript.segments);
            resolve(msg.transcript);
          } else {
            reject(new Error(msg.error));
          }
        };

        worker.addEventListener('message', handleMessage);
        const request: EngineWorkerRequest = {
          id: requestId,
          mode: 'transcription',
          fileName: selectedFile.name,
          audio: samples,
          selectedModels: { whisper: selectedEngineModels.whisper },
          useWebGpu: webGpuSupport === 'supported',
          whisperDtype: whisperQuantization,
        };
        worker.postMessage(request, [samples.buffer]);
      });

      setTranscriptionResult(transcript);
      setEngineStatus('idle');
      setEngineMessage(`Transcription completed for ${selectedFile.name}.`);
    } catch (error) {
      setEngineStatus('error');
      setEngineMessage(
        error instanceof Error ? error.message : 'Transcription failed.',
      );
    }
  }

  async function handleRunDiarization() {
    const selectedFile = files.find((file) => file.name === selectedAudioName);

    if (selectedFile === undefined) {
      setEngineMessage('Select a stored recording first.');
      return;
    }

    if (selectedEngineModels.pyannote.length === 0) {
      setEngineMessage('Download a Pyannote model first.');
      return;
    }

    setEngineStatus('processing');
    setEngineMessage(`Diarizing ${selectedFile.name}...`);
    setEngineLog([`Starting diarization of ${selectedFile.name}.`]);
    setEngineBarValue(null);
    setEngineProgress({
      transcription: undefined,
      diarization: undefined,
      'speaker-naming': undefined,
    });
    setDiarizationResult(null);

    try {
      const audioFile = await selectedFile.fileHandle.getFile();
      setEngineLog((current) => [
        ...current,
        `Decoding ${selectedFile.name} (${formatBytes(audioFile.size)})...`,
      ]);
      const samples = await decodeAudioBlobToMonoFloat32(
        audioFile,
        WHISPER_SAMPLE_RATE,
      );
      setEngineLog((current) => [
        ...current,
        `Decoded ${(samples.length / WHISPER_SAMPLE_RATE).toFixed(1)}s of audio.`,
        `Using Pyannote ${selectedEngineModels.pyannote}.`,
      ]);

      const worker = getEngineWorker();
      const requestId = ++engineRequestIdRef.current;

      const turns = await new Promise<SpeakerTurn[]>((resolve, reject) => {
        const handleMessage = (event: MessageEvent<EngineWorkerResponse>) => {
          const msg = event.data;

          if (msg.id !== requestId) {
            return;
          }

          if (msg.type === 'progress') {
            const { stage, status } = msg.event;
            setEngineProgress((current) => ({ ...current, [stage]: status }));
            setEngineLog((current) => [...current, `[${stage}] ${status}`]);
            return;
          }

          if (msg.type === 'log') {
            setEngineLog((current) => [...current, msg.line]);
            return;
          }

          if (msg.type === 'bar') {
            setEngineBarValue(msg.value);
            return;
          }

          if (msg.type === 'live-transcript') {
            return;
          }

          worker.removeEventListener('message', handleMessage);

          if (msg.ok) {
            if (msg.mode !== 'diarization') {
              reject(new Error('Worker returned an unexpected result.'));
              return;
            }

            resolve(msg.turns);
          } else {
            reject(new Error(msg.error));
          }
        };

        worker.addEventListener('message', handleMessage);
        const request: EngineWorkerRequest = {
          id: requestId,
          mode: 'diarization',
          fileName: selectedFile.name,
          audio: samples,
          selectedModels: { pyannote: selectedEngineModels.pyannote },
          useWebGpu: webGpuSupport === 'supported',
          whisperDtype: whisperQuantization,
          numSpeakers: numSpeakersHint,
        };
        worker.postMessage(request, [samples.buffer]);
      });

      setDiarizationResult(turns);
      setEngineStatus('idle');
      setEngineMessage(
        `Diarization completed: ${turns.length} speaker turn${turns.length === 1 ? '' : 's'} detected.`,
      );
    } catch (error) {
      setEngineStatus('error');
      setEngineMessage(
        error instanceof Error ? error.message : 'Diarization failed.',
      );
    }
  }

  function getActiveModelVersion(
    model: ManagedModel,
  ): ModelVersionManifestEntry | undefined {
    return modelVersions.find(
      (version) => version.model === model && version.active,
    );
  }

  const activeModelCount = MODEL_DOWNLOAD_TARGETS.filter(
    (target) => getActiveModelVersion(target.model) !== undefined,
  ).length;
  const downloadPercent = downloadProgress?.totalBytes
    ? Math.min(
        100,
        Math.round(
          (downloadProgress.loadedBytes / downloadProgress.totalBytes) * 100,
        ),
      )
    : null;

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span>Notetaker Lab</span>
          <strong>Local meeting engine</strong>
        </div>
        <nav className={styles.nav} aria-label="Test app sections">
          {[
            ['models', 'Models', `${activeModelCount}/3 active`],
            ['recordings', 'Recordings', `${files.length} saved`],
            ['transcription', 'Transcription', engineStatus],
            ['diarization', 'Diarization', engineStatus],
            ['engine', 'Engine', engineStatus],
          ].map(([page, label, detail]) => (
            <button
              key={page}
              type="button"
              data-active={activePage === page}
              onClick={() => setActivePage(page as AppPage)}
            >
              <span>{label}</span>
              <small>{detail}</small>
            </button>
          ))}
        </nav>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.hero}>
          <p className={styles.eyebrow}>Browser-only test harness</p>
          <h1>
            {activePage === 'models'
              ? 'Prepare local models'
              : activePage === 'recordings'
                ? 'Capture meeting audio'
                : activePage === 'transcription'
                  ? 'Run transcription only'
                  : activePage === 'diarization'
                    ? 'Run diarization only'
                    : 'Run the engine pipeline'}
          </h1>
          <p>
            {activePage === 'models'
              ? 'Search Hugging Face, download model files, and activate them in OPFS before processing meetings.'
              : activePage === 'recordings'
                ? 'Record microphone audio directly into OPFS and keep a small local library for engine testing.'
                : activePage === 'transcription'
                  ? 'Select a saved recording and run just the Whisper transcription engine with live segment updates.'
                  : activePage === 'diarization'
                    ? 'Select a saved recording and run just the Pyannote speaker diarization engine to inspect raw speaker turns.'
                    : 'Select a saved recording and run transcription, diarization, and speaker naming orchestration.'}
          </p>
        </header>

        <div className={styles.statsGrid}>
          <article>
            <span>Recorder</span>
            <strong data-state={status}>{status}</strong>
          </article>
          <article>
            <span>Active models</span>
            <strong>{activeModelCount}/3</strong>
          </article>
          <article>
            <span>Recordings</span>
            <strong>{files.length}</strong>
          </article>
        </div>

        {activePage === 'models' ? (
          <section className={styles.panel}>
            <div className={styles.listHeader}>
              <div>
                <p className={styles.label}>OPFS/models</p>
                <h2>Model search</h2>
              </div>
              <span>
                {modelVersions.length} version
                {modelVersions.length === 1 ? '' : 's'}
              </span>
            </div>
            <p className={styles.message}>{modelMessage}</p>

            {modelVersions.length === 0 ? (
              <p className={styles.empty}>No models downloaded yet.</p>
            ) : (
              <div className={styles.downloadedModels}>
                <div className={styles.listHeader}>
                  <div>
                    <p className={styles.label}>Downloaded</p>
                    <h3>Stored model versions</h3>
                  </div>
                  <span>
                    {modelVersions.length} version
                    {modelVersions.length === 1 ? '' : 's'}
                  </span>
                </div>
                <ul className={styles.modelVersionList}>
                  {modelVersions.map((version) => (
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
                        onClick={() => void handleRemoveModelVersion(version)}
                        disabled={downloadingModel !== null}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className={styles.directDownloads}>
              <div>
                <p className={styles.label}>Direct ONNX downloads</p>
                <h3>Whisper presets</h3>
                <p>
                  These use Xenova Whisper ONNX repositories and download the
                  encoder, merged decoder, tokenizer, and config files into the
                  active Whisper slot.
                </p>
              </div>
              <div className={styles.presetGrid}>
                {WHISPER_ONNX_DOWNLOADS.map((download) => {
                  const downloadedVersion = getDirectDownloadVersion(download);

                  return (
                    <article key={getDirectDownloadKey(download)}>
                      <strong>{download.label}</strong>
                      <span>{download.id}</span>
                      <span>{formatBytes(getKnownDownloadSize(download))}</span>
                      {downloadedVersion !== undefined ? (
                        <span className={styles.downloadedBadge}>
                          downloaded
                        </span>
                      ) : null}
                      <p>{download.description}</p>
                      <button
                        type="button"
                        onClick={() => void handleDownloadDirectModel(download)}
                        disabled={
                          downloadingModel !== null || downloadedVersion !== undefined
                        }
                      >
                        {downloadedVersion !== undefined
                          ? 'Downloaded'
                          : downloadingModel === 'whisper'
                            ? 'Downloading...'
                            : 'Download ONNX'}
                      </button>
                    </article>
                  );
                })}
              </div>
            </div>

            <div className={styles.directDownloads}>
              <div>
                <p className={styles.label}>Direct Pyannote ONNX downloads</p>
                <h3>Token-free diarization building blocks</h3>
                <p>
                  These community ONNX exports do not require a Hugging Face
                  token. Download segmentation and embedding models to prepare a
                  local diarization pipeline.
                </p>
              </div>
              <div className={styles.presetGrid}>
                {PYANNOTE_DOWNLOADS.map((download) => {
                  const downloadedVersion = getDirectDownloadVersion(download);

                  return (
                    <article key={getDirectDownloadKey(download)}>
                      <strong>{download.label}</strong>
                      <span>{download.id}</span>
                      <span>{formatBytes(getKnownDownloadSize(download))}</span>
                      {downloadedVersion !== undefined ? (
                        <span className={styles.downloadedBadge}>
                          downloaded
                        </span>
                      ) : null}
                      <p>{download.description}</p>
                      <button
                        type="button"
                        onClick={() => void handleDownloadDirectModel(download)}
                        disabled={
                          downloadingModel !== null || downloadedVersion !== undefined
                        }
                      >
                        {downloadedVersion !== undefined
                          ? 'Downloaded'
                          : downloadingModel === 'pyannote'
                            ? 'Downloading...'
                            : 'Download Pyannote'}
                      </button>
                    </article>
                  );
                })}
              </div>
            </div>

            <div className={styles.directDownloads}>
              <div>
                <p className={styles.label}>Direct Gemma 4 downloads</p>
                <h3>Official and quantized google/gemma-4 presets</h3>
                <p>
                  These direct buttons include official Google BF16 safetensors
                  plus public quantized GGUF/ONNX builds based on the matching
                  google/gemma-4 models.
                </p>
              </div>
              <div className={styles.presetGrid}>
                {GEMMA_DOWNLOADS.map((download) => {
                  const downloadedVersion = getDirectDownloadVersion(download);

                  return (
                    <article key={getDirectDownloadKey(download)}>
                      <strong>{download.label}</strong>
                      <span>{download.id}</span>
                      <span>{formatBytes(getKnownDownloadSize(download))}</span>
                      {downloadedVersion !== undefined ? (
                        <span className={styles.downloadedBadge}>
                          downloaded
                        </span>
                      ) : null}
                      <p>{download.description}</p>
                      <button
                        type="button"
                        onClick={() => void handleDownloadDirectModel(download)}
                        disabled={
                          downloadingModel !== null || downloadedVersion !== undefined
                        }
                      >
                        {downloadedVersion !== undefined
                          ? 'Downloaded'
                          : downloadingModel === 'gemma4'
                            ? 'Downloading...'
                            : 'Download Gemma'}
                      </button>
                    </article>
                  );
                })}
              </div>
            </div>

            <div className={styles.modelGrid}>
              {MODEL_DOWNLOAD_TARGETS.map((target) => {
                const activeModel = getActiveModelVersion(target.model);
                const search = modelSearches[target.model];

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
                    <div className={styles.searchRow}>
                      <input
                        aria-label={`${target.label} Hugging Face search`}
                        type="search"
                        placeholder={target.defaultSearch}
                        value={search.query}
                        onChange={(event) =>
                          handleModelQueryChange(
                            target.model,
                            event.target.value,
                          )
                        }
                      />
                      <button
                        type="button"
                        onClick={() => void handleSearchModels(target)}
                        disabled={search.searching || downloadingModel !== null}
                      >
                        {search.searching ? 'Searching...' : 'Search'}
                      </button>
                    </div>

                    {search.results.length > 0 ? (
                      <ul className={styles.modelResults}>
                        {search.results.map((result) => {
                          const files = getDownloadableFiles(result);
                          const selectedFile =
                            search.selectedFiles[result.id] ?? files[0] ?? '';
                          const selectedFileUrl =
                            selectedFile.length === 0
                              ? null
                              : buildHuggingFaceDownloadUrl(
                                  result.id,
                                  selectedFile,
                                );
                          const downloadedVersion =
                            selectedFile.length === 0
                              ? undefined
                              : getSearchDownloadVersion(
                                  target.model,
                                  result.id,
                                  selectedFile,
                                );

                          return (
                            <li key={result.id}>
                              <div>
                                <strong>{result.id}</strong>
                                <span>
                                  {(result.downloads ?? 0).toLocaleString()}{' '}
                                  downloads |{' '}
                                  {(result.likes ?? 0).toLocaleString()} likes
                                </span>
                                <span>
                                  Selected file:{' '}
                                  {selectedFileUrl === null
                                    ? 'none'
                                    : formatOptionalBytes(
                                        getKnownFileSize(selectedFileUrl),
                                      )}
                                </span>
                                {downloadedVersion !== undefined ? (
                                  <span className={styles.downloadedBadge}>
                                    downloaded
                                  </span>
                                ) : null}
                              </div>
                              <select
                                aria-label={`${result.id} file`}
                                value={selectedFile}
                                onChange={(event) =>
                                  handleSelectedModelFileChange(
                                    target.model,
                                    result.id,
                                    event.target.value,
                                  )
                                }
                              >
                                {files.map((fileName) => (
                                  <option
                                    key={`${result.id}-${fileName}`}
                                    value={fileName}
                                  >
                                    {fileName}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                onClick={() =>
                                  void handleDownloadModel(target, result)
                                }
                                disabled={
                                  downloadingModel !== null ||
                                  downloadedVersion !== undefined
                                }
                              >
                                {downloadedVersion !== undefined
                                  ? 'Downloaded'
                                  : downloadingModel === target.model
                                    ? 'Downloading...'
                                    : 'Download & Activate'}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

        {activePage === 'recordings' ? (
          <>
            <section className={styles.panel}>
              <div className={styles.listHeader}>
                <div>
                  <p className={styles.label}>Recorder</p>
                  <h2>Capture audio</h2>
                </div>
                <span data-state={status}>{status}</span>
              </div>
              <p className={styles.message}>{message}</p>

              <label className={styles.uploadBox}>
                <span>Upload recordings</span>
                <strong>
                  Import MP3, WAV, M4A, WebM, or OGG files into
                  OPFS/audio-files.
                </strong>
                <input
                  type="file"
                  accept="audio/*,.mp3,.m4a,.wav,.webm,.ogg"
                  multiple
                  onChange={(event) => {
                    void handleUploadRecordings(event.target.files);
                    event.currentTarget.value = '';
                  }}
                  disabled={
                    status === 'idle' ||
                    status === 'recording' ||
                    status === 'saving'
                  }
                />
              </label>

              <div className={styles.actions}>
                <button
                  type="button"
                  onClick={handleStartRecording}
                  disabled={status !== 'ready'}
                >
                  Start Recording
                </button>
                <button
                  type="button"
                  onClick={handleStopRecording}
                  disabled={status !== 'recording'}
                >
                  Stop & Save
                </button>
                <button
                  type="button"
                  onClick={handleCancelRecording}
                  disabled={status !== 'recording'}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void refreshFiles()}
                  disabled={
                    status === 'idle' ||
                    status === 'recording' ||
                    status === 'saving'
                  }
                >
                  Refresh Files
                </button>
              </div>

              {lastRecording !== null ? (
                <p className={styles.saved}>
                  Last saved: <strong>{lastRecording.fileName}</strong> (
                  {formatBytes(lastRecording.size)})
                </p>
              ) : null}
            </section>

            <section className={styles.panel}>
              <div className={styles.listHeader}>
                <div>
                  <p className={styles.label}>OPFS/audio-files</p>
                  <h2>Stored recordings</h2>
                </div>
                <span>
                  {files.length} file{files.length === 1 ? '' : 's'}
                </span>
              </div>

              {files.length === 0 ? (
                <p className={styles.empty}>No recordings stored yet.</p>
              ) : (
                <ul className={styles.fileList}>
                  {files.map((file) => (
                    <li key={`${file.name}-${file.updatedAt}`}>
                      <div>
                        <strong>{file.name}</strong>
                        <span>
                          {file.type} | {formatBytes(file.size)} |{' '}
                          {formatDate(file.updatedAt)}
                        </span>
                      </div>
                      <audio controls src={file.url} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : null}

        {activePage === 'transcription' ? (
          <section className={styles.panel}>
            <div className={styles.listHeader}>
              <div>
                <p className={styles.label}>Transcription</p>
                <h2>Run Whisper only</h2>
              </div>
              <span data-state={engineStatus}>{engineStatus}</span>
            </div>
            <p className={styles.message}>{engineMessage}</p>

            <div className={styles.runtimeStatus} data-state={webGpuSupport}>
              <strong>{getWebGpuSupportLabel(webGpuSupport)}</strong>
              <span>
                {webGpuSupport === 'supported'
                  ? 'Whisper is pinned to WASM; current q8 ONNX exports fail in ORT Web.'
                  : 'Whisper will run on the WASM backend.'}
              </span>
            </div>

            <div className={styles.engineModelGrid}>
              <label className={styles.engineModelPicker}>
                <span>Whisper precision</span>
                <select
                  value={whisperQuantization}
                  onChange={(event) =>
                    setWhisperQuantization(
                      event.target.value as WhisperQuantization,
                    )
                  }
                  disabled={engineStatus === 'processing'}
                >
                  <option value="fp32">Full precision fp32 (WASM)</option>
                </select>
              </label>

              <label className={styles.engineModelPicker}>
                <span>Whisper model</span>
                <select
                  value={selectedEngineModels.whisper}
                  onChange={(event) =>
                    setSelectedEngineModels((current) => ({
                      ...current,
                      whisper: event.target.value,
                    }))
                  }
                  disabled={
                    engineStatus === 'processing' ||
                    modelVersions.filter(
                      (version) => version.model === 'whisper',
                    ).length === 0
                  }
                >
                  <option value="">
                    {modelVersions.some(
                      (version) => version.model === 'whisper',
                    )
                      ? 'Select a model version'
                      : 'No downloaded versions'}
                  </option>
                  {modelVersions
                    .filter((version) => version.model === 'whisper')
                    .map((version) => (
                      <option
                        key={`whisper-transcription-${version.version}`}
                        value={version.version}
                      >
                        {getModelVersionTitle(version)}
                        {version.active ? ' (active)' : ''}
                      </option>
                    ))}
                </select>
              </label>
            </div>

            <ul className={styles.engineProgress}>
              <li data-status={engineProgress.transcription ?? 'pending'}>
                <span>Transcription</span>
                <small>{engineProgress.transcription ?? 'pending'}</small>
              </li>
            </ul>

            <div className={styles.engineControls}>
              <select
                value={selectedAudioName}
                onChange={(event) => setSelectedAudioName(event.target.value)}
                disabled={files.length === 0 || engineStatus === 'processing'}
              >
                <option value="">Select recording</option>
                {files.map((file) => (
                  <option
                    key={`${file.name}-transcription-option`}
                    value={file.name}
                  >
                    {file.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void handleRunTranscription()}
                disabled={
                  selectedAudioName.length === 0 ||
                  engineStatus === 'processing'
                }
              >
                Transcribe Only
              </button>
            </div>

            {transcriptionResult !== null ? (
              <div className={styles.transcriptResult}>
                <h3>Transcript</h3>
                <p>{transcriptionResult.text}</p>
                <ul>
                  {transcriptionResult.segments.map((segment, index) => (
                    <li key={`${segment.startSeconds}-${index}`}>
                      <strong>{formatTimestamp(segment.startSeconds)}</strong>
                      <span>{segment.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ) : null}

        {activePage === 'diarization' ? (
          <section className={styles.panel}>
            <div className={styles.listHeader}>
              <div>
                <p className={styles.label}>Diarization</p>
                <h2>Run Pyannote only</h2>
              </div>
              <span data-state={engineStatus}>{engineStatus}</span>
            </div>
            <p className={styles.message}>{engineMessage}</p>

            <div className={styles.engineModelGrid}>
              <label className={styles.engineModelPicker}>
                <span>Pyannote model</span>
                <select
                  value={selectedEngineModels.pyannote}
                  onChange={(event) =>
                    setSelectedEngineModels((current) => ({
                      ...current,
                      pyannote: event.target.value,
                    }))
                  }
                  disabled={
                    engineStatus === 'processing' ||
                    modelVersions.filter(
                      (version) => version.model === 'pyannote',
                    ).length === 0
                  }
                >
                  <option value="">
                    {modelVersions.some(
                      (version) => version.model === 'pyannote',
                    )
                      ? 'Select a model version'
                      : 'No downloaded versions'}
                  </option>
                  {modelVersions
                    .filter((version) => version.model === 'pyannote')
                    .map((version) => (
                      <option
                        key={`pyannote-diarization-${version.version}`}
                        value={version.version}
                      >
                        {getModelVersionTitle(version)}
                        {version.active ? ' (active)' : ''}
                      </option>
                    ))}
                </select>
              </label>
              <label className={styles.engineModelPicker}>
                <span>Number of speakers (optional)</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  placeholder="Auto-detect"
                  value={numSpeakersHint ?? ''}
                  onChange={(event) => {
                    const val = event.target.value;
                    setNumSpeakersHint(val === '' ? null : Math.max(1, parseInt(val, 10)));
                  }}
                  disabled={engineStatus === 'processing'}
                />
              </label>
            </div>

            <ul className={styles.engineProgress}>
              <li data-status={engineProgress.diarization ?? 'pending'}>
                <span>Diarization</span>
                <small>{engineProgress.diarization ?? 'pending'}</small>
              </li>
            </ul>

            {engineBarValue !== null || engineStatus === 'processing' ? (
              <div className={styles.progressTrack} aria-hidden="true">
                <div
                  data-indeterminate={
                    engineBarValue === null && engineStatus === 'processing'
                  }
                  style={
                    engineBarValue !== null
                      ? { width: `${engineBarValue}%` }
                      : undefined
                  }
                />
              </div>
            ) : null}

            <div className={styles.engineControls}>
              <select
                value={selectedAudioName}
                onChange={(event) => setSelectedAudioName(event.target.value)}
                disabled={files.length === 0 || engineStatus === 'processing'}
              >
                <option value="">Select recording</option>
                {files.map((file) => (
                  <option
                    key={`${file.name}-diarization-option`}
                    value={file.name}
                  >
                    {file.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void handleRunDiarization()}
                disabled={
                  selectedAudioName.length === 0 ||
                  engineStatus === 'processing'
                }
              >
                Diarize Only
              </button>
            </div>

            <div ref={engineLogRef} className={styles.engineLog}>
              {engineLog.length === 0 ? (
                <p className={styles.empty}>Waiting for output...</p>
              ) : (
                engineLog.map((line, index) => (
                  <p key={`${index}-${line.slice(0, 32)}`}>{line}</p>
                ))
              )}
            </div>

            {diarizationResult !== null ? (
              <div className={styles.transcriptResult}>
                <h3>
                  Speaker turns —{' '}
                  {[...new Set(diarizationResult.map((t) => t.speaker))].length}{' '}
                  speaker
                  {[...new Set(diarizationResult.map((t) => t.speaker))].length === 1 ? '' : 's'},{' '}
                  {diarizationResult.length} turn
                  {diarizationResult.length === 1 ? '' : 's'}
                </h3>
                <ul>
                  {diarizationResult.map((turn, index) => (
                    <li key={`${turn.startSeconds}-${index}`}>
                      <strong>{turn.speaker}</strong>
                      <span>
                        {formatTimestamp(turn.startSeconds)} →{' '}
                        {formatTimestamp(turn.endSeconds)} (
                        {(turn.endSeconds - turn.startSeconds).toFixed(1)}s)
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ) : null}

        {activePage === 'engine' ? (
          <section className={styles.panel}>
            <div className={styles.listHeader}>
              <div>
                <p className={styles.label}>Engine</p>
                <h2>Process a meeting</h2>
              </div>
              <span data-state={engineStatus}>{engineStatus}</span>
            </div>
            <p className={styles.message}>{engineMessage}</p>

            <div className={styles.runtimeStatus} data-state={webGpuSupport}>
              <strong>{getWebGpuSupportLabel(webGpuSupport)}</strong>
              <span>
                {webGpuSupport === 'supported'
                  ? 'Whisper is pinned to WASM; current q8 ONNX exports fail in ORT Web.'
                  : 'Whisper will run on the WASM backend.'}
              </span>
            </div>

            <label className={styles.engineModelPicker}>
              <span>Whisper precision</span>
              <select
                value={whisperQuantization}
                onChange={(event) =>
                  setWhisperQuantization(
                    event.target.value as WhisperQuantization,
                  )
                }
                disabled={engineStatus === 'processing'}
              >
                <option value="fp32">Full precision fp32 (WASM)</option>
              </select>
            </label>

            <ul className={styles.engineProgress}>
              {(
                [
                  ['transcription', 'Transcription'],
                  ['diarization', 'Diarization'],
                  ['speaker-naming', 'Speaker naming'],
                ] as const
              ).map(([stage, label]) => (
                <li
                  key={stage}
                  data-status={engineProgress[stage] ?? 'pending'}
                >
                  <span>{label}</span>
                  <small>{engineProgress[stage] ?? 'pending'}</small>
                </li>
              ))}
            </ul>

            <div className={styles.engineModelGrid}>
              {MODEL_DOWNLOAD_TARGETS.map((target) => {
                const versions = modelVersions.filter(
                  (version) => version.model === target.model,
                );

                return (
                  <label
                    key={target.model}
                    className={styles.engineModelPicker}
                  >
                    <span>{target.label} model</span>
                    <select
                      value={selectedEngineModels[target.model]}
                      onChange={(event) =>
                        setSelectedEngineModels((current) => ({
                          ...current,
                          [target.model]: event.target.value,
                        }))
                      }
                      disabled={
                        engineStatus === 'processing' || versions.length === 0
                      }
                    >
                      <option value="">
                        {versions.length === 0
                          ? 'No downloaded versions'
                          : 'Select a model version'}
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
                );
              })}
            </div>

            <div className={styles.engineControls}>
              <select
                value={selectedAudioName}
                onChange={(event) => setSelectedAudioName(event.target.value)}
                disabled={files.length === 0 || engineStatus === 'processing'}
              >
                <option value="">Select recording</option>
                {files.map((file) => (
                  <option key={`${file.name}-option`} value={file.name}>
                    {file.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void handleRunEngine()}
                disabled={
                  selectedAudioName.length === 0 ||
                  engineStatus === 'processing'
                }
              >
                Run Engine
              </button>
            </div>

            {meetingNotes !== null ? (
              <div className={styles.transcriptResult}>
                <h3>{meetingNotes.meeting.title}</h3>
                <p>{meetingNotes.transcript.text}</p>
                <ul>
                  {meetingNotes.segments.map((segment, index) => (
                    <li key={`${segment.startSeconds}-${index}`}>
                      <strong>{segment.speakerName}</strong>
                      <span>{segment.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ) : null}
      </section>

      {engineDialogOpen ? (
        <div
          className={styles.downloadOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="Transcription progress"
        >
          <section className={styles.downloadDialog}>
            <div className={styles.listHeader}>
              <div>
                <p className={styles.label}>
                  {engineDialogMode === 'transcription'
                    ? 'Transcription'
                    : 'Engine'}
                </p>
                <h2>
                  {engineDialogMode === 'transcription'
                    ? 'Transcribing'
                    : 'Processing'}{' '}
                  {selectedAudioName}
                </h2>
              </div>
              <span data-state={engineStatus}>{engineStatus}</span>
            </div>

            <ul className={styles.engineProgress}>
              {(
                [
                  ['transcription', 'Transcription'],
                  ['diarization', 'Diarization'],
                  ['speaker-naming', 'Speaker naming'],
                ] as const
              ).map(([stage, label]) =>
                engineDialogMode === 'transcription' &&
                stage !== 'transcription' ? null : (
                  <li
                    key={stage}
                    data-status={engineProgress[stage] ?? 'pending'}
                  >
                    <span>{label}</span>
                    <small>{engineProgress[stage] ?? 'pending'}</small>
                  </li>
                ),
              )}
            </ul>

            <div className={styles.progressTrack} aria-hidden="true">
              <div
                data-indeterminate={
                  engineBarValue === null && engineStatus === 'processing'
                }
                style={
                  engineBarValue !== null
                    ? { width: `${engineBarValue}%` }
                    : undefined
                }
              />
            </div>

            <div className={styles.liveTranscript}>
              <div className={styles.liveTranscriptHeader}>
                <strong>Live transcript</strong>
                <span>{liveTranscriptSegments.length} segments</span>
              </div>
              {liveTranscriptSegments.length === 0 ? (
                <p className={styles.empty}>Waiting for speech...</p>
              ) : (
                <div className={styles.liveTranscriptBody}>
                  {liveTranscriptSegments.map((segment, index) => (
                    <p key={`${segment.startSeconds}-${index}`}>
                      <time>{formatTimestamp(segment.startSeconds)}</time>
                      <span>{segment.text}</span>
                    </p>
                  ))}
                </div>
              )}
            </div>

            <div ref={engineLogRef} className={styles.engineLog}>
              {engineLog.length === 0 ? (
                <p className={styles.empty}>Waiting for output...</p>
              ) : (
                engineLog.map((line, index) => (
                  <p key={`${index}-${line.slice(0, 32)}`}>{line}</p>
                ))
              )}
            </div>

            {engineStatus !== 'processing' ? (
              <button type="button" onClick={() => setEngineDialogOpen(false)}>
                Close
              </button>
            ) : null}
          </section>
        </div>
      ) : null}

      {downloadProgress !== null ? (
        <div
          className={styles.downloadOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="Download progress"
        >
          <section className={styles.downloadDialog}>
            <div className={styles.listHeader}>
              <div>
                <p className={styles.label}>Download</p>
                <h2>{downloadProgress.title}</h2>
              </div>
              <span>{downloadProgress.status}</span>
            </div>
            <p className={styles.message}>
              File {downloadProgress.fileIndex} of {downloadProgress.fileCount}:{' '}
              {downloadProgress.currentFile}
            </p>
            <div className={styles.progressTrack}>
              <div style={{ width: `${downloadPercent ?? 8}%` }} />
            </div>
            <p className={styles.progressMeta}>
              {formatBytes(downloadProgress.loadedBytes)} /{' '}
              {downloadProgress.totalBytes === null
                ? 'unknown'
                : formatBytes(downloadProgress.totalBytes)}
              {downloadPercent === null ? '' : ` (${downloadPercent}%)`}
            </p>
            {downloadProgress.status === 'complete' ||
            downloadProgress.status === 'error' ? (
              <button type="button" onClick={() => setDownloadProgress(null)}>
                Close
              </button>
            ) : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}

export default App;
