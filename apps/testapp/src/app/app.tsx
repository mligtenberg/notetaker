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
import { DiarizationPage } from './components/diarization-page';
import { EnginePage } from './components/engine-page';
import { ModelsPage } from './components/models-page';
import { RecordingsPage } from './components/recordings-page';
import { TranscriptionPage } from './components/transcription-page';
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
type AppPage =
  | 'models'
  | 'recordings'
  | 'transcription'
  | 'diarization'
  | 'engine';
type WebGpuSupport = 'checking' | 'supported' | 'unsupported';
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
  quantization?: string;
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

const MODEL_DOWNLOAD_TARGETS: ModelDownloadTarget[] = [
  {
    model: 'whisper',
    label: 'Whisper',
    description:
      'Transcription model for Whisper and Faster-Whisper downloads.',
  },
  {
    model: 'pyannote',
    label: 'Pyannote',
    description: 'Speaker diarization model',
  },
  {
    model: 'gemma4',
    label: 'Gemma 4',
    description:
      'Speaker naming model. Suggests ONNX Community Gemma 4 browser/WebGPU models.',
  },
  {
    model: 'wav2vec2',
    label: 'Wav2Vec2',
    description:
      'CTC ASR model for transcript-to-timecode alignment experiments.',
  },
];

const WHISPER_ONNX_DOWNLOADS: DirectModelDownload[] = [
  createWhisperOnnxDownload(
    'onnx-community/whisper-tiny',
    'Tiny ONNX FP32',
    'Current transformers.js full-precision ONNX tiny model.',
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
    'onnx-community/whisper-tiny',
    'Tiny ONNX Q8',
    'Current transformers.js quantized ONNX tiny model.',
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
      'onnx/encoder_model_quantized.onnx': 10124990,
      'onnx/decoder_model_merged_quantized.onnx': 30719241,
    },
    'q8',
  ),
  createWhisperOnnxDownload(
    'onnx-community/whisper-base',
    'Base ONNX FP32',
    'Current transformers.js full-precision ONNX base model.',
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
    'onnx-community/whisper-base',
    'Base ONNX Q8',
    'Current transformers.js quantized ONNX base model.',
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
      'onnx/encoder_model_quantized.onnx': 23201314,
      'onnx/decoder_model_merged_quantized.onnx': 53693315,
    },
    'q8',
  ),
  createWhisperOnnxDownload(
    'onnx-community/whisper-small',
    'Small ONNX FP32',
    'Current transformers.js full-precision ONNX small model.',
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
  createWhisperOnnxDownload(
    'onnx-community/whisper-small',
    'Small ONNX Q8',
    'Current transformers.js quantized ONNX small model.',
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
      'onnx/encoder_model_quantized.onnx': 92326160,
      'onnx/decoder_model_merged_quantized.onnx': 156750845,
    },
    'q8',
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
  quantization: string,
): DirectModelDownload {
  return {
    id: PYANNOTE_REPO,
    label,
    description,
    model: 'pyannote',
    quantization,
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
    'fp32',
  ),
  createPyannoteDownload(
    'Segmentation 3.0 Q8',
    'Quantized ONNX segmentation model (~1.5 MB). Same accuracy, 4× smaller.',
    'onnx/model_quantized.onnx',
    1542308,
    'q8',
  ),
  createPyannoteDownload(
    'Segmentation 3.0 INT8',
    'INT8-quantized ONNX segmentation model (~1.5 MB). Equivalent to Q8.',
    'onnx/model_int8.onnx',
    1542304,
    'int8',
  ),
];
const GEMMA_DOWNLOADS: DirectModelDownload[] = [
  createDirectModelDownload({
    id: 'onnx-community/gemma-4-E2B-it-ONNX',
    label: 'ONNX Community E2B Q4',
    description:
      'Q4 ONNX text-generation files from ONNX Community for browser/WebGPU testing.',
    model: 'gemma4',
    quantization: 'q4',
    files: {
      'chat_template.jinja': 16317,
      'config.json': 5549,
      'generation_config.json': 238,
      'onnx/decoder_model_merged_q4.onnx': 647599,
      'onnx/decoder_model_merged_q4.onnx_data': 1864102912,
      'onnx/embed_tokens_q4.onnx': 5142,
      'onnx/embed_tokens_q4.onnx_data': 1762656256,
      'preprocessor_config.json': 43,
      'processor_config.json': 1689,
      'tokenizer.json': 19439251,
      'tokenizer_config.json': 18807,
    },
  }),
  createDirectModelDownload({
    id: 'onnx-community/gemma-4-E4B-it-ONNX',
    label: 'ONNX Community E4B Q4',
    description:
      'Q4 ONNX text-generation files from ONNX Community for larger browser/WebGPU testing.',
    model: 'gemma4',
    quantization: 'q4',
    files: {
      'chat_template.jinja': 16317,
      'config.json': 5741,
      'generation_config.json': 238,
      'onnx/decoder_model_merged_q4.onnx': 814829,
      'onnx/decoder_model_merged_q4.onnx_data': 2093703168,
      'onnx/decoder_model_merged_q4.onnx_data_1': 1286205440,
      'onnx/embed_tokens_q4.onnx': 5134,
      'onnx/embed_tokens_q4.onnx_data': 1839202304,
      'onnx/embed_tokens_q4.onnx_data_1': 396361728,
      'preprocessor_config.json': 43,
      'processor_config.json': 1689,
      'tokenizer.json': 19439251,
      'tokenizer_config.json': 18807,
    },
  }),
];
const WAV2VEC2_DOWNLOADS: DirectModelDownload[] = [
  createDirectModelDownload({
    id: 'onnx-community/wav2vec2-base-960h-ONNX',
    label: 'Base 960h ONNX FP32',
    description:
      'Full-precision Wav2Vec2 CTC model. Suitable for forced-alignment experiments, but alignment is not wired into the engine yet.',
    model: 'wav2vec2',
    quantization: 'fp32',
    files: {
      'config.json': 2157,
      'preprocessor_config.json': 215,
      'quantize_config.json': 312,
      'special_tokens_map.json': 96,
      'tokenizer.json': 2187,
      'tokenizer_config.json': 1178,
      'vocab.json': 358,
      'onnx/model.onnx': 377911891,
    },
  }),
  createDirectModelDownload({
    id: 'onnx-community/wav2vec2-base-960h-ONNX',
    label: 'Base 960h ONNX Q8',
    description:
      'Quantized Wav2Vec2 CTC model for smaller local alignment experiments. Alignment is not wired into the engine yet.',
    model: 'wav2vec2',
    quantization: 'q8',
    files: {
      'config.json': 2157,
      'preprocessor_config.json': 215,
      'quantize_config.json': 312,
      'special_tokens_map.json': 96,
      'tokenizer.json': 2187,
      'tokenizer_config.json': 1178,
      'vocab.json': 358,
      'onnx/model_quantized.onnx': 95212816,
    },
  }),
];

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
  onDebug?: (line: string) => void,
): Promise<Float32Array> {
  onDebug?.(
    `[decode] source blob size=${formatBytes(blob.size)} type=${blob.type || 'unknown'}`,
  );

  if (blob.size === 0) {
    throw new Error('Selected audio file is empty.');
  }

  const arrayBuffer = await blob.arrayBuffer();
  onDebug?.(
    `[decode] loaded ${formatBytes(arrayBuffer.byteLength)} into memory.`,
  );
  const decodeContext = new AudioContext();

  try {
    const decoded = await decodeContext.decodeAudioData(arrayBuffer.slice(0));
    onDebug?.(
      `[decode] decoded duration=${decoded.duration.toFixed(3)}s sampleRate=${decoded.sampleRate} channels=${decoded.numberOfChannels} frames=${decoded.length}`,
    );
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
    const renderedDuration = samples.length / targetSampleRate;
    onDebug?.(
      `[decode] resampled frames=${samples.length} duration=${renderedDuration.toFixed(3)}s targetSampleRate=${targetSampleRate}`,
    );
    if (samples.length === 0) {
      throw new Error(
        `Resampled audio is empty (${decoded.duration.toFixed(3)}s decoded duration).`,
      );
    }

    if (renderedDuration < 0.1) {
      throw new Error(
        `Decoded audio is unexpectedly short (${renderedDuration.toFixed(3)}s from ${formatBytes(blob.size)} source file).`,
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

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

function normalizeQuantization(quantization: string): string {
  return quantization
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-');
}

function getQuantizedVersionName(
  modelName: string,
  quantization?: string,
): string {
  if (quantization === undefined || quantization.length === 0) {
    return modelName;
  }

  return `${modelName}--${normalizeQuantization(quantization)}`;
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
  quantization = 'fp32',
): DirectModelDownload {
  return {
    id: repositoryId,
    label,
    description,
    model: 'whisper',
    quantization,
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
  quantization?: string;
  files: Record<string, number>;
}): DirectModelDownload {
  return {
    id: options.id,
    label: options.label,
    description: options.description,
    model: options.model,
    quantization: options.quantization,
    files: Object.entries(options.files).map(([path, size]) => ({
      path,
      url: buildHuggingFaceDownloadUrl(options.id, path),
      type: resolveModelFileType(path),
      size,
    })),
  };
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

function getWhisperRuntimeLabel(version: ModelVersionManifestEntry): string {
  const quantization =
    version.quantization ?? version.metadata?.['quantization'];

  return typeof quantization === 'string' && quantization.length > 0
    ? `auto device with ${quantization} quantization from the active Whisper model`
    : 'auto device with quantization from the active Whisper model';
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
  const [modelVersions, setModelVersions] = useState<
    ModelVersionManifestEntry[]
  >([]);
  const [downloadingModel, setDownloadingModel] = useState<ManagedModel | null>(
    null,
  );
  const [selectedAudioName, setSelectedAudioName] = useState('');
  const [meetingNotes, setMeetingNotes] = useState<MeetingNotes | null>(null);
  const [transcriptionResult, setTranscriptionResult] =
    useState<Transcript | null>(null);
  const [diarizationResult, setDiarizationResult] = useState<
    SpeakerTurn[] | null
  >(null);
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
  const engineLogRef = useRef<HTMLDivElement | null>(null);
  const [engineProgress, setEngineProgress] = useState<
    Record<EngineStage, EngineProgressEvent['status'] | undefined>
  >({
    transcription: undefined,
    diarization: undefined,
    'speaker-naming': undefined,
  });
  const [activePage, setActivePage] = useState<AppPage>('models');
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

    if (
      typeof huggingFaceModelId === 'string' &&
      huggingFaceModelId.length > 0
    ) {
      return typeof huggingFaceFile === 'string' && huggingFaceFile.length > 0
        ? `${huggingFaceModelId} / ${huggingFaceFile}`
        : huggingFaceModelId;
    }

    return version.version;
  }

  function getModelVersionDetail(version: ModelVersionManifestEntry): string {
    const size = version.files.reduce((total, file) => total + file.size, 0);
    const quantization =
      version.quantization ?? version.metadata?.['quantization'];
    const quantizationLabel =
      typeof quantization === 'string' && quantization.length > 0
        ? ` | ${quantization}`
        : '';

    return `${version.version}${quantizationLabel} | ${formatBytes(size)}`;
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
        (download.quantization === undefined ||
          version.quantization === download.quantization ||
          metadata['quantization'] === download.quantization) &&
        Array.isArray(storedSourceUrls) &&
        sourceUrls.length === storedSourceUrls.length &&
        sourceUrls.every((url) => storedSourceUrls.includes(url))
      );
    });
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
          'Ready. Manage downloaded model versions in OPFS/models.',
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

  async function handleDeleteRecording(file: StoredAudioFile) {
    const directoryHandle = directoryHandleRef.current;

    if (directoryHandle === null) {
      return;
    }

    const confirmed = window.confirm(`Delete ${file.name}?`);

    if (!confirmed) {
      return;
    }

    try {
      setStatus('saving');
      setMessage(`Deleting ${file.name} from OPFS/audio-files...`);
      await directoryHandle.removeEntry(file.name);

      if (selectedAudioName === file.name) {
        setSelectedAudioName('');
        setMeetingNotes(null);
        setTranscriptionResult(null);
        setDiarizationResult(null);
        setEngineMessage('Select a recording and run the engine.');
      }

      if (lastRecording?.fileName === file.name) {
        setLastRecording(null);
      }

      await refreshFiles(directoryHandle);
      setStatus('ready');
      setMessage(`Deleted ${file.name} from OPFS/audio-files.`);
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error
          ? error.message
          : `Failed to delete ${file.name}.`,
      );
    }
  }

  function handleCancelRecording() {
    recorderRef.current?.cancel();
    setStatus('ready');
    setMessage('Recording canceled. No audio file was stored.');
  }

  function getModelVersions(model: ManagedModel): ModelVersionManifestEntry[] {
    return modelVersions.filter((version) => version.model === model);
  }

  async function handleSetActiveModelVersion(
    model: ManagedModel,
    version: string,
  ) {
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

      const modelName = getQuantizedVersionName(
        download.id.replaceAll('/', '__'),
        download.quantization,
      );
      const version = `${modelName}--direct--${new Date()
        .toISOString()
        .replaceAll(':', '-')}`;

      setDownloadProgress((currentProgress) =>
        currentProgress === null
          ? null
          : { ...currentProgress, status: 'saving' },
      );

      await modelManager.addVersion({
        model: download.model,
        modelName,
        version,
        quantization: download.quantization,
        activate: true,
        files,
        metadata: {
          title: download.label,
          format: download.model === 'gemma4' ? 'direct-hugging-face' : 'onnx',
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
      const worker = new EngineWorker();

      worker.addEventListener('error', (event) => {
        appendEngineLog(
          `[worker] error ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`,
        );
      });
      worker.addEventListener('messageerror', () => {
        appendEngineLog(
          '[worker] messageerror while transferring request/response.',
        );
      });
      engineWorkerRef.current = worker;
    }

    return engineWorkerRef.current;
  }

  function appendEngineLog(line: string): void {
    setEngineLog((current) => [...current, line]);
  }

  function handleWorkerUpdate(msg: EngineWorkerResponse): boolean {
    if (msg.type === 'progress') {
      const { stage, status } = msg.event;
      setEngineProgress((current) => ({ ...current, [stage]: status }));
      appendEngineLog(`[${stage}] ${status}`);
      return true;
    }

    if (msg.type === 'log') {
      appendEngineLog(msg.line);
      return true;
    }

    if (msg.type === 'bar') {
      setEngineBarValue(msg.value);
      return true;
    }

    if (msg.type === 'live-transcript') {
      setLiveTranscriptSegments(msg.segments);
      return true;
    }

    return false;
  }

  async function handleRunEngine() {
    const selectedFile = files.find((file) => file.name === selectedAudioName);
    const missingModel = MODEL_DOWNLOAD_TARGETS.find(
      (target) => getActiveModelVersion(target.model) === undefined,
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
      const activeWhisper = getActiveModelVersion('whisper');
      const activePyannote = getActiveModelVersion('pyannote');
      const activeGemma4 = getActiveModelVersion('gemma4');

      if (
        activeWhisper === undefined ||
        activePyannote === undefined ||
        activeGemma4 === undefined
      ) {
        throw new Error('Download and activate all required models first.');
      }

      setEngineMessage(`Decoding ${selectedFile.name}...`);
      setEngineLog((current) => [
        ...current,
        `Decoding ${selectedFile.name} (${formatBytes(audioFile.size)})...`,
        `[file] selected=${selectedFile.name} handleSize=${formatBytes(selectedFile.size)} currentSize=${formatBytes(audioFile.size)} type=${audioFile.type || selectedFile.type || 'unknown'}`,
      ]);
      const samples = await decodeAudioBlobToMonoFloat32(
        audioFile,
        WHISPER_SAMPLE_RATE,
        appendEngineLog,
      );
      if (samples.length === 0) {
        throw new Error('Decoded audio produced no samples.');
      }
      const sampleCount = samples.length;
      const sampleDurationSeconds = sampleCount / WHISPER_SAMPLE_RATE;
      setEngineLog((current) => [
        ...current,
        `Decoded ${sampleDurationSeconds.toFixed(3)}s of audio (${sampleCount} samples).`,
        `Runtime: ${getWhisperRuntimeLabel(activeWhisper)}`,
        `Using Whisper ${getModelVersionTitle(activeWhisper)}.`,
        `Using Pyannote ${getModelVersionTitle(activePyannote)}.`,
        `Using Gemma 4 ${getModelVersionTitle(activeGemma4)}.`,
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

          if (handleWorkerUpdate(msg)) {
            return;
          }

          if (msg.type !== 'result') {
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
          useWebGpu: webGpuSupport === 'supported',
          numSpeakers: numSpeakersHint,
        };
        appendEngineLog(
          `[worker] posting engine request ${requestId} with ${sampleCount} samples (${sampleDurationSeconds.toFixed(3)}s).`,
        );
        worker.postMessage(request, [samples.buffer]);
        appendEngineLog(`[worker] posted engine request ${requestId}.`);
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

    const activeWhisper = getActiveModelVersion('whisper');

    if (activeWhisper === undefined) {
      setEngineMessage('Download a Whisper model first.');
      return;
    }

    setEngineStatus('processing');
    setEngineMessage(`Transcribing ${selectedFile.name}...`);
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
        `[file] selected=${selectedFile.name} handleSize=${formatBytes(selectedFile.size)} currentSize=${formatBytes(audioFile.size)} type=${audioFile.type || selectedFile.type || 'unknown'}`,
      ]);
      const samples = await decodeAudioBlobToMonoFloat32(
        audioFile,
        WHISPER_SAMPLE_RATE,
        appendEngineLog,
      );
      if (samples.length === 0) {
        throw new Error('Decoded audio produced no samples.');
      }
      const sampleCount = samples.length;
      const sampleDurationSeconds = sampleCount / WHISPER_SAMPLE_RATE;
      setEngineLog((current) => [
        ...current,
        `Decoded ${sampleDurationSeconds.toFixed(3)}s of audio (${sampleCount} samples).`,
        `Runtime: ${getWhisperRuntimeLabel(activeWhisper)}`,
        `Using Whisper ${getModelVersionTitle(activeWhisper)}.`,
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

          if (handleWorkerUpdate(msg)) {
            return;
          }

          if (msg.type !== 'result') {
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
          useWebGpu: webGpuSupport === 'supported',
        };
        appendEngineLog(
          `[worker] posting transcription request ${requestId} with ${sampleCount} samples (${sampleDurationSeconds.toFixed(3)}s).`,
        );
        worker.postMessage(request, [samples.buffer]);
        appendEngineLog(`[worker] posted transcription request ${requestId}.`);
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

    const activePyannote = getActiveModelVersion('pyannote');

    if (activePyannote === undefined) {
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
        `[file] selected=${selectedFile.name} handleSize=${formatBytes(selectedFile.size)} currentSize=${formatBytes(audioFile.size)} type=${audioFile.type || selectedFile.type || 'unknown'}`,
      ]);
      const samples = await decodeAudioBlobToMonoFloat32(
        audioFile,
        WHISPER_SAMPLE_RATE,
        appendEngineLog,
      );
      if (samples.length === 0) {
        throw new Error('Decoded audio produced no samples.');
      }
      const sampleCount = samples.length;
      const sampleDurationSeconds = sampleCount / WHISPER_SAMPLE_RATE;
      setEngineLog((current) => [
        ...current,
        `Decoded ${sampleDurationSeconds.toFixed(3)}s of audio (${sampleCount} samples).`,
        `Using Pyannote ${getModelVersionTitle(activePyannote)}.`,
      ]);

      const worker = getEngineWorker();
      const requestId = ++engineRequestIdRef.current;

      const turns = await new Promise<SpeakerTurn[]>((resolve, reject) => {
        const handleMessage = (event: MessageEvent<EngineWorkerResponse>) => {
          const msg = event.data;

          if (msg.id !== requestId) {
            return;
          }

          if (msg.type === 'live-transcript') {
            return;
          }

          if (handleWorkerUpdate(msg)) {
            return;
          }

          if (msg.type !== 'result') {
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
          useWebGpu: webGpuSupport === 'supported',
          numSpeakers: numSpeakersHint,
        };
        appendEngineLog(
          `[worker] posting diarization request ${requestId} with ${sampleCount} samples (${sampleDurationSeconds.toFixed(3)}s).`,
        );
        worker.postMessage(request, [samples.buffer]);
        appendEngineLog(`[worker] posted diarization request ${requestId}.`);
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
            ['models', 'Models', `${activeModelCount}/4 active`],
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
              ? 'Download model files and choose the active version in OPFS before processing meetings.'
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
            <strong>{activeModelCount}/4</strong>
          </article>
          <article>
            <span>Recordings</span>
            <strong>{files.length}</strong>
          </article>
        </div>

        {activePage === 'models' ? (
          <ModelsPage
            modelVersions={modelVersions}
            modelMessage={modelMessage}
            downloadingModel={downloadingModel}
            modelTargets={MODEL_DOWNLOAD_TARGETS}
            downloadSections={[
              {
                eyebrow: 'Direct ONNX downloads',
                title: 'Whisper presets',
                description:
                  'These use ONNX Community Whisper repositories and download the encoder, merged decoder, tokenizer, and config files into the active Whisper slot.',
                downloads: WHISPER_ONNX_DOWNLOADS,
                buttonLabel: 'Download ONNX',
                downloadingLabel: 'Downloading...',
              },
              {
                eyebrow: 'Direct Pyannote ONNX downloads',
                title: 'Token-free diarization building blocks',
                description:
                  'These community ONNX exports do not require a Hugging Face token. Download segmentation and embedding models to prepare a local diarization pipeline.',
                downloads: PYANNOTE_DOWNLOADS,
                buttonLabel: 'Download Pyannote',
                downloadingLabel: 'Downloading...',
              },
              {
                eyebrow: 'Direct Gemma 4 downloads',
                title: 'ONNX Community Gemma 4 presets',
                description:
                  'These direct buttons include Q4 ONNX text-generation files from the ONNX Community Gemma 4 repositories.',
                downloads: GEMMA_DOWNLOADS,
                buttonLabel: 'Download Gemma',
                downloadingLabel: 'Downloading...',
              },
              {
                eyebrow: 'Direct Wav2Vec2 ONNX downloads',
                title: 'CTC alignment presets',
                description:
                  'These ONNX Community Wav2Vec2 CTC models can provide frame-level emissions for transcript-to-timecode alignment, but the alignment engine is not implemented yet.',
                downloads: WAV2VEC2_DOWNLOADS,
                buttonLabel: 'Download Wav2Vec2',
                downloadingLabel: 'Downloading...',
              },
            ]}
            getKnownDownloadSize={getKnownDownloadSize}
            getDirectDownloadKey={getDirectDownloadKey}
            getDirectDownloadVersion={getDirectDownloadVersion}
            getModelVersions={getModelVersions}
            getModelVersionTitle={getModelVersionTitle}
            getModelVersionDetail={getModelVersionDetail}
            onDownloadDirectModel={(download) =>
              void handleDownloadDirectModel(download)
            }
            onSetActiveModelVersion={(model, version) =>
              void handleSetActiveModelVersion(model, version)
            }
            onRemoveModelVersion={(version) =>
              void handleRemoveModelVersion(version)
            }
            formatBytes={formatBytes}
          />
        ) : null}

        {activePage === 'recordings' ? (
          <RecordingsPage
            status={status}
            message={message}
            files={files}
            lastRecording={lastRecording}
            onUploadRecordings={(uploadedFiles) =>
              void handleUploadRecordings(uploadedFiles)
            }
            onStartRecording={handleStartRecording}
            onStopRecording={handleStopRecording}
            onCancelRecording={handleCancelRecording}
            onRefreshFiles={() => void refreshFiles()}
            onDeleteRecording={(file) => void handleDeleteRecording(file)}
            formatBytes={formatBytes}
            formatDate={formatDate}
          />
        ) : null}

        {activePage === 'transcription' ? (
          <TranscriptionPage
            engineStatus={engineStatus}
            engineMessage={engineMessage}
            webGpuSupport={webGpuSupport}
            engineProgress={engineProgress}
            selectedAudioName={selectedAudioName}
            files={files}
            transcriptionResult={transcriptionResult}
            engineLog={engineLog}
            engineBarValue={engineBarValue}
            liveTranscriptSegments={liveTranscriptSegments}
            activeWhisper={getActiveModelVersion('whisper')}
            onSelectedAudioNameChange={setSelectedAudioName}
            onRunTranscription={() => void handleRunTranscription()}
            getWebGpuSupportLabel={getWebGpuSupportLabel}
            getModelVersionTitle={getModelVersionTitle}
          />
        ) : null}

        {activePage === 'diarization' ? (
          <DiarizationPage
            engineStatus={engineStatus}
            engineMessage={engineMessage}
            engineProgress={engineProgress}
            engineBarValue={engineBarValue}
            selectedAudioName={selectedAudioName}
            files={files}
            numSpeakersHint={numSpeakersHint}
            diarizationResult={diarizationResult}
            engineLog={engineLog}
            engineLogRef={engineLogRef}
            activePyannote={getActiveModelVersion('pyannote')}
            onSelectedAudioNameChange={setSelectedAudioName}
            onNumSpeakersHintChange={setNumSpeakersHint}
            onRunDiarization={() => void handleRunDiarization()}
            getModelVersionTitle={getModelVersionTitle}
            formatTimestamp={formatTimestamp}
          />
        ) : null}

        {activePage === 'engine' ? (
          <EnginePage
            engineStatus={engineStatus}
            engineMessage={engineMessage}
            webGpuSupport={webGpuSupport}
            engineProgress={engineProgress}
            selectedAudioName={selectedAudioName}
            files={files}
            meetingNotes={meetingNotes}
            engineLog={engineLog}
            engineBarValue={engineBarValue}
            liveTranscriptSegments={liveTranscriptSegments}
            numSpeakersHint={numSpeakersHint}
            modelTargets={MODEL_DOWNLOAD_TARGETS}
            onSelectedAudioNameChange={setSelectedAudioName}
            onNumSpeakersHintChange={setNumSpeakersHint}
            onRunEngine={() => void handleRunEngine()}
            getWebGpuSupportLabel={getWebGpuSupportLabel}
            getActiveModelVersion={getActiveModelVersion}
            getModelVersionTitle={getModelVersionTitle}
          />
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
