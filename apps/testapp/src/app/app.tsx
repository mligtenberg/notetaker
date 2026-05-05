import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { AudioRecorder } from '@notetaker/audio-recorder';
import {
  type SpeakerTurn,
  type Transcript,
} from '@notetaker/engine';
import {
  FileSystem,
  MeetingsRepository,
  type LanguageMode,
  type MeetingArtifactKind,
  type StoredMeetingSummary,
} from '@notetaker/filesystem';
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
import { MeetingDetailPage } from './components/meeting-detail-page';
import { MeetingsPage } from './components/meetings-page';
import { ModelsPage } from './components/models-page';
import styles from './app.module.css';

interface LiveTranscriptSegment {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

type RecorderStatus = 'idle' | 'ready' | 'recording' | 'saving' | 'error';
type EngineStatus = 'idle' | 'processing' | 'error';
type AppPage = 'models' | 'meetings';

const PAGE_PATHS: Record<AppPage, string> = {
  models: '/models',
  meetings: '/meetings',
};

function resolveActivePage(pathname: string): AppPage {
  const segment = pathname.split('/')[1] ?? '';

  if (segment === 'models' || segment === 'meetings') {
    return segment;
  }

  return 'models';
}

function resolveViewingMeetingId(pathname: string): string | null {
  const parts = pathname.split('/');
  if (
    parts[1] === 'meetings' &&
    parts[2] !== undefined &&
    parts[2].length > 0
  ) {
    return parts[2];
  }
  return null;
}
type WebGpuSupport = 'checking' | 'supported' | 'unsupported';
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
    model: 'transcription',
    label: 'Transcription',
    description:
      'Transcription model for Whisper and Faster-Whisper downloads.',
  },
  {
    model: 'diarization',
    label: 'Diarization',
    description: 'Speaker diarization model',
  },
  {
    model: 'language',
    label: 'Language',
    description:
      'Speaker naming model. Suggests ONNX Community Gemma 4 browser/WebGPU models.',
  },
  {
    model: 'text-audio-sync',
    label: 'Text-Audio Sync',
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
    model: 'diarization',
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
  {
    id: 'altunenes/speaker-diarization-community-1-onnx',
    label: 'Community-1 ONNX FP32',
    description:
      'Community ONNX export of pyannote/speaker-diarization-community-1: segmentation (~5.9 MB) + embedding (~26.5 MB). CC-BY-4.0, no HF token gate. Processor configs reused from segmentation-3.0 (same architecture).',
    model: 'diarization',
    quantization: 'fp32',
    files: [
      {
        path: 'config.json',
        url: buildHuggingFaceDownloadUrl(PYANNOTE_REPO, 'config.json'),
        type: 'application/json',
        size: 408,
      },
      {
        path: 'preprocessor_config.json',
        url: buildHuggingFaceDownloadUrl(
          PYANNOTE_REPO,
          'preprocessor_config.json',
        ),
        type: 'application/json',
        size: 158,
      },
      {
        path: 'onnx/model.onnx',
        url: buildHuggingFaceDownloadUrl(
          'altunenes/speaker-diarization-community-1-onnx',
          'segmentation-community-1.onnx',
        ),
        type: 'application/octet-stream',
        size: 5916375,
      },
      {
        path: 'onnx/embedding_model.onnx',
        url: buildHuggingFaceDownloadUrl(
          'altunenes/speaker-diarization-community-1-onnx',
          'embedding_model.onnx',
        ),
        type: 'application/octet-stream',
        size: 26544032,
      },
    ],
  },
];
const GEMMA_DOWNLOADS: DirectModelDownload[] = [
  createDirectModelDownload({
    id: 'onnx-community/gemma-4-E2B-it-ONNX',
    label: 'ONNX Community E2B Q4',
    description:
      'Q4 ONNX text-generation files from ONNX Community for browser/WebGPU testing.',
    model: 'language',
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
    model: 'language',
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
    model: 'text-audio-sync',
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
    model: 'text-audio-sync',
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
    throw new Error('Selected media file is empty.');
  }

  const arrayBuffer = await blob.arrayBuffer();
  onDebug?.(
    `[decode] loaded ${formatBytes(arrayBuffer.byteLength)} into memory.`,
  );
  const decodeContext = new AudioContext();

  try {
    const decoded = await decodeContext
      .decodeAudioData(arrayBuffer.slice(0))
      .catch((error: unknown) => {
        throw new Error(
          `Could not decode an audio track from this media file: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
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

function renumberSpeakersSequentially(turns: SpeakerTurn[]): SpeakerTurn[] {
  const speakers = [...new Set(turns.map((turn) => turn.speaker))].sort();
  const numberedSpeakers = speakers
    .map((speaker) => ({ speaker, match: /^(.*?)(\d+)$/.exec(speaker) }))
    .filter(
      (
        item,
      ): item is {
        speaker: string;
        match: RegExpExecArray;
      } => item.match !== null,
    );

  if (numberedSpeakers.length !== speakers.length) {
    return turns;
  }

  const prefixes = new Set(numberedSpeakers.map(({ match }) => match[1]));

  if (prefixes.size !== 1) {
    return turns;
  }

  const digitCount = Math.max(
    ...numberedSpeakers.map(({ match }) => match[2]!.length),
  );
  const prefix = numberedSpeakers[0]?.match[1] ?? '';
  const speakerMap = new Map(
    numberedSpeakers.map(({ speaker }, index) => [
      speaker,
      `${prefix}${String(index).padStart(digitCount, '0')}`,
    ]),
  );

  return turns.map((turn) => ({
    ...turn,
    speaker: speakerMap.get(turn.speaker) ?? turn.speaker,
  }));
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
    model: 'transcription',
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

function mimeTypeToExtension(mimeType: string): string {
  if (mimeType.includes('mp4')) {
    return mimeType.startsWith('video/') ? 'mp4' : 'm4a';
  }

  if (mimeType.includes('quicktime')) {
    return 'mov';
  }

  if (mimeType.includes('ogg')) {
    return 'ogg';
  }

  if (mimeType.includes('wav')) {
    return 'wav';
  }

  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) {
    return 'mp3';
  }

  return 'webm';
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
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

function getWhisperRuntimeLabel(version: ModelVersionManifestEntry): string {
  const quantization =
    version.quantization ?? version.metadata?.['quantization'];

  return typeof quantization === 'string' && quantization.length > 0
    ? `auto device with ${quantization} quantization from the active Whisper model`
    : 'auto device with quantization from the active Whisper model';
}

export function App() {
  const recorderRef = useRef<AudioRecorder | null>(null);
  const meetingsRepoRef = useRef<MeetingsRepository | null>(null);
  const modelManagerRef = useRef<ModelManager | null>(null);
  const engineWorkerRef = useRef<Worker | null>(null);
  const engineRequestIdRef = useRef(0);
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [engineStatus, setEngineStatus] = useState<EngineStatus>('idle');
  const [message, setMessage] = useState('Opening OPFS meetings folder...');
  const [modelMessage, setModelMessage] = useState(
    'Opening OPFS models folder...',
  );
  const [engineMessage, setEngineMessage] = useState(
    'Select a meeting and run the engine.',
  );
  const [meetings, setMeetings] = useState<StoredMeetingSummary[]>([]);
  const [artifactRevision, setArtifactRevision] = useState(0);
  const [meetingUrls, setMeetingUrls] = useState<Record<string, string>>({});
  const [creatingMeeting, setCreatingMeeting] = useState(false);
  const [modelVersions, setModelVersions] = useState<
    ModelVersionManifestEntry[]
  >([]);
  const [downloadingModel, setDownloadingModel] = useState<ManagedModel | null>(
    null,
  );
  const [selectedMeetingId, setSelectedMeetingId] = useState('');
  const [recordingMeetingId, setRecordingMeetingId] = useState<string | null>(
    null,
  );
  const [engineDialogOpen, setEngineDialogOpen] = useState(false);
  const [engineDialogMode, setEngineDialogMode] = useState<
    'engine' | 'transcription'
  >('engine');
  const [engineLog, setEngineLog] = useState<string[]>([]);
  const [liveTranscriptSegments, setLiveTranscriptSegments] = useState<
    LiveTranscriptSegment[]
  >([]);
  const [liveTranscriptMeetingId, setLiveTranscriptMeetingId] = useState<
    string | null
  >(null);
  const [webGpuSupport, setWebGpuSupport] = useState<WebGpuSupport>('checking');
  const engineLogRef = useRef<HTMLDivElement | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const activePage = resolveActivePage(location.pathname);
  const viewingMeetingId = resolveViewingMeetingId(location.pathname);
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgressState | null>(null);

  useEffect(() => {
    if (location.pathname === '/' || location.pathname === '') {
      navigate('/models', { replace: true });
    }
  }, [location.pathname, navigate]);

  useEffect(() => {
    return () => {
      for (const url of Object.values(meetingUrls)) {
        URL.revokeObjectURL(url);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!engineDialogOpen) {
      return;
    }

    const node = engineLogRef.current;

    if (node !== null) {
      node.scrollTop = node.scrollHeight;
    }
  }, [engineDialogOpen, engineLog]);

  async function refreshMeetings(repo = meetingsRepoRef.current) {
    if (repo === null) {
      return;
    }

    const summaries = await repo.list();

    setMeetingUrls((current) => {
      const next: Record<string, string> = {};
      const keepIds = new Set(summaries.map((m) => m.id));

      for (const [id, url] of Object.entries(current)) {
        if (keepIds.has(id)) {
          next[id] = url;
        } else {
          URL.revokeObjectURL(url);
        }
      }

      return next;
    });

    setMeetings(summaries);

    for (const summary of summaries) {
      if (meetingUrls[summary.id] !== undefined) {
        continue;
      }

      try {
        const file = await repo.loadRecording(summary.id);
        const url = URL.createObjectURL(file);
        setMeetingUrls((current) =>
          current[summary.id] === undefined
            ? { ...current, [summary.id]: url }
            : (URL.revokeObjectURL(url), current),
        );
      } catch {
        // Recording missing — skip url generation.
      }
    }

    if (selectedMeetingId.length === 0 && summaries[0] !== undefined) {
      setSelectedMeetingId(summaries[0].id);
    }
  }

  async function refreshModelVersions(modelManager = modelManagerRef.current) {
    if (modelManager === null) {
      return;
    }

    setModelVersions(await modelManager.listVersions());
  }

  async function saveMeetingArtifact<T>(
    meetingId: string,
    kind: MeetingArtifactKind,
    data: T,
  ): Promise<void> {
    const repo = meetingsRepoRef.current;

    if (repo === null) {
      throw new Error('Meetings repository is not ready.');
    }

    await repo.saveArtifact(meetingId, kind, data);

    if (kind === 'diarization') {
      await repo.deleteArtifact(meetingId, 'speaker-names');
    }

    await refreshMeetings(repo);
    setArtifactRevision((current) => current + 1);
  }

  async function deleteMeetingArtifact(
    meetingId: string,
    kind: MeetingArtifactKind,
  ): Promise<void> {
    const repo = meetingsRepoRef.current;

    if (repo === null) {
      throw new Error('Meetings repository is not ready.');
    }

    await repo.deleteArtifact(meetingId, kind);
    await refreshMeetings(repo);
    setArtifactRevision((current) => current + 1);
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
        const meetingsDir = await fileSystem.getMeetingsDir();
        const modelManager = await ModelManager.create(fileSystem);

        if (!isMounted) {
          return;
        }

        const repo = new MeetingsRepository(meetingsDir);
        meetingsRepoRef.current = repo;
        modelManagerRef.current = modelManager;
        recorderRef.current = new AudioRecorder(meetingsDir);
        await refreshMeetings(repo);
        await refreshModelVersions(modelManager);
        setStatus('ready');
        setMessage('Ready. Meetings will be saved to OPFS/meetings.');
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
            : 'Failed to open OPFS meetings folder.',
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

  async function handleCreateMeeting() {
    const repo = meetingsRepoRef.current;

    if (repo === null || creatingMeeting) {
      return;
    }

    try {
      setCreatingMeeting(true);
      const meeting = await repo.create({
        name: 'Untitled meeting',
        date: todayIsoDate(),
        participantCount: 2,
      });
      await refreshMeetings(repo);
      setSelectedMeetingId(meeting.id);
      setStatus('ready');
      setMessage('');
      navigate(`/meetings/${meeting.id}`);
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error ? error.message : 'Failed to create meeting.',
      );
    } finally {
      setCreatingMeeting(false);
    }
  }

  const loadMeetingArtifact = useCallback(
    <T,>(meetingId: string, kind: MeetingArtifactKind): Promise<T | null> => {
      const repo = meetingsRepoRef.current;

      if (repo === null) {
        return Promise.resolve(null);
      }

      return repo.loadArtifact<T>(meetingId, kind);
    },
    [],
  );

  async function handleUpdateMeeting(
    id: string,
    patch: Partial<{
      name: string;
      date: string;
      participantCount: number;
      languageMode: LanguageMode;
    }>,
  ) {
    const repo = meetingsRepoRef.current;

    if (repo === null) {
      return;
    }

    try {
      await repo.updateMetadata(id, patch);
      await refreshMeetings(repo);
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error ? error.message : 'Failed to update meeting.',
      );
    }
  }

  async function handleStartRecording(meetingId: string) {
    const recorder = recorderRef.current;
    if (recorder === null) {
      return;
    }

    try {
      setMessage('Requesting microphone access...');
      await recorder.start();
      setRecordingMeetingId(meetingId);
      setStatus('recording');
      setMessage('Recording. Stop to attach the audio to the meeting.');
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error ? error.message : 'Failed to start recording.',
      );
    }
  }

  async function handleStopRecording() {
    const recorder = recorderRef.current;
    const repo = meetingsRepoRef.current;
    const meetingId = recordingMeetingId;

    if (recorder === null || repo === null || meetingId === null) {
      return;
    }

    try {
      setStatus('saving');
      setMessage('Saving recording...');
      const recording = await recorder.stop();
      // Remove the scratch file the recorder wrote to the meetings root.
      try {
        await repo.directoryHandle.removeEntry(recording.fileName);
      } catch {
        // Ignore; scratch file may already be gone.
      }

      const summary = await repo.attachRecording(meetingId, {
        blob: recording.blob,
        mimeType: recording.mimeType,
        extension: mimeTypeToExtension(recording.mimeType),
      });

      // Drop any cached object URL so the new recording is reloaded.
      setMeetingUrls((current) => {
        const url = current[meetingId];
        if (url === undefined) {
          return current;
        }
        URL.revokeObjectURL(url);
        const next = { ...current };
        delete next[meetingId];
        return next;
      });

      await refreshMeetings(repo);
      setRecordingMeetingId(null);
      setStatus('ready');
      setMessage(`Attached recording to "${summary.name}".`);
    } catch (error) {
      setRecordingMeetingId(null);
      setStatus('error');
      setMessage(
        error instanceof Error ? error.message : 'Failed to save recording.',
      );
    }
  }

  async function handleUploadRecording(meetingId: string, file: File) {
    const repo = meetingsRepoRef.current;

    if (repo === null) {
      return;
    }

    try {
      setStatus('saving');
      setMessage(`Importing ${file.name}...`);

      const mimeType = file.type || 'application/octet-stream';
      const extensionFromName = file.name.includes('.')
        ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
        : '';
      const extension =
        extensionFromName.length > 0
          ? extensionFromName
          : mimeTypeToExtension(mimeType);

      const summary = await repo.attachRecording(meetingId, {
        blob: file,
        mimeType,
        extension,
      });

      setMeetingUrls((current) => {
        const url = current[meetingId];
        if (url === undefined) {
          return current;
        }
        URL.revokeObjectURL(url);
        const next = { ...current };
        delete next[meetingId];
        return next;
      });

      await refreshMeetings(repo);
      setStatus('ready');
      setMessage(`Imported ${file.name} into "${summary.name}".`);
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error ? error.message : 'Failed to import audio file.',
      );
    }
  }

  async function handleDeleteMeeting(meeting: StoredMeetingSummary) {
    const repo = meetingsRepoRef.current;

    if (repo === null) {
      return;
    }

    const confirmed = window.confirm(`Delete meeting "${meeting.name}"?`);

    if (!confirmed) {
      return;
    }

    try {
      setStatus('saving');
      setMessage(`Deleting meeting "${meeting.name}"...`);
      await repo.delete(meeting.id);

      const url = meetingUrls[meeting.id];
      if (url !== undefined) {
        URL.revokeObjectURL(url);
        setMeetingUrls((current) => {
          const next = { ...current };
          delete next[meeting.id];
          return next;
        });
      }

      if (selectedMeetingId === meeting.id) {
        setSelectedMeetingId('');
        setEngineMessage('Select a meeting and run the engine.');
      }

      if (viewingMeetingId === meeting.id) {
        navigate('/meetings');
      }

      await refreshMeetings(repo);
      setStatus('ready');
      setMessage(`Deleted meeting "${meeting.name}".`);
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error
          ? error.message
          : `Failed to delete meeting "${meeting.name}".`,
      );
    }
  }

  function handleCancelRecording() {
    recorderRef.current?.cancel();
    setRecordingMeetingId(null);
    setStatus('ready');
    setMessage('Recording canceled. No audio was attached.');
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
      appendEngineLog(`[${stage}] ${status}`);
      return true;
    }

    if (msg.type === 'log') {
      appendEngineLog(msg.line);
      return true;
    }

    if (msg.type === 'bar') {
      return true;
    }

    if (msg.type === 'live-transcript') {
      setLiveTranscriptSegments(msg.segments);
      return true;
    }

    return false;
  }

  async function handleRunTranscription(meetingId: string = selectedMeetingId) {
    const repo = meetingsRepoRef.current;
    const selectedMeeting = meetings.find(
      (meeting) => meeting.id === meetingId,
    );
    if (repo === null || selectedMeeting === undefined) {
      setEngineMessage('Select a stored meeting first.');
      return;
    }

    const activeWhisper = getActiveModelVersion('transcription');

    if (activeWhisper === undefined) {
      setEngineMessage('Download a Whisper model first.');
      return;
    }

    setEngineStatus('processing');
    setEngineMessage(`Transcribing ${selectedMeeting.name}...`);
    setEngineLog([
      `Starting transcription-only run for ${selectedMeeting.name}.`,
    ]);
    setLiveTranscriptMeetingId(selectedMeeting.id);
    setLiveTranscriptSegments([]);

    try {
      // Drop any previously-saved transcript (and its dependents) before
      // starting. If this run is interrupted (page refresh, crash) the
      // meeting will be left in a clean "no transcript" state rather than
      // showing stale data from a prior run.
      await repo.deleteArtifact(selectedMeeting.id, 'transcript');
      await repo.deleteArtifact(selectedMeeting.id, 'word-sync');
      await repo.deleteArtifact(selectedMeeting.id, 'speaker-names');
      await refreshMeetings(repo);
      setArtifactRevision((current) => current + 1);

      const audioFile = await repo.loadRecording(selectedMeeting.id);
      setEngineMessage(`Decoding ${selectedMeeting.name}...`);
      setEngineLog((current) => [
        ...current,
        `Decoding ${selectedMeeting.name} (${formatBytes(audioFile.size)})...`,
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
      setEngineMessage(`Transcribing ${selectedMeeting.name}...`);
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
          fileName: selectedMeeting.name,
          audio: samples,
          useWebGpu: webGpuSupport === 'supported',
          languageMode: selectedMeeting.languageMode ?? 'auto-once',
        };
        appendEngineLog(
          `[worker] posting transcription request ${requestId} with ${sampleCount} samples (${sampleDurationSeconds.toFixed(3)}s).`,
        );
        worker.postMessage(request, [samples.buffer]);
        appendEngineLog(`[worker] posted transcription request ${requestId}.`);
      });

      await repo.saveArtifact(selectedMeeting.id, 'transcript', transcript);
      await repo.deleteArtifact(selectedMeeting.id, 'word-sync');
      await repo.deleteArtifact(selectedMeeting.id, 'speaker-names');
      await refreshMeetings(repo);
      setArtifactRevision((current) => current + 1);

      setLiveTranscriptMeetingId(null);
      setEngineStatus('idle');
      setEngineMessage(`Transcription completed for ${selectedMeeting.name}.`);
    } catch (error) {
      setLiveTranscriptMeetingId(null);
      setEngineStatus('error');
      const message =
        error instanceof Error ? error.message : 'Transcription failed.';
      setEngineMessage(message);
      appendEngineLog(`[error] ${message}`);
      console.error('[engine] transcription failed', error);
    }
  }

  async function handleRunDiarization(meetingId: string = selectedMeetingId) {
    const repo = meetingsRepoRef.current;
    const selectedMeeting = meetings.find(
      (meeting) => meeting.id === meetingId,
    );

    if (repo === null || selectedMeeting === undefined) {
      setEngineMessage('Select a stored meeting first.');
      return;
    }

    const activePyannote = getActiveModelVersion('diarization');

    if (activePyannote === undefined) {
      setEngineMessage('Download a Pyannote model first.');
      return;
    }

    setEngineStatus('processing');
    setLiveTranscriptMeetingId(null);
    setEngineMessage(`Diarizing ${selectedMeeting.name}...`);
    setEngineLog([`Starting diarization of ${selectedMeeting.name}.`]);

    try {
      await repo.deleteArtifact(selectedMeeting.id, 'diarization');
      await repo.deleteArtifact(selectedMeeting.id, 'word-sync');
      await repo.deleteArtifact(selectedMeeting.id, 'speaker-names');
      await refreshMeetings(repo);
      setArtifactRevision((current) => current + 1);

      const audioFile = await repo.loadRecording(selectedMeeting.id);
      setEngineLog((current) => [
        ...current,
        `Decoding ${selectedMeeting.name} (${formatBytes(audioFile.size)})...`,
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
        `Speaker hint: ${selectedMeeting.participantCount} meeting participants.`,
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
          fileName: selectedMeeting.name,
          audio: samples,
          useWebGpu: webGpuSupport === 'supported',
          numSpeakers: selectedMeeting.participantCount,
        };
        appendEngineLog(
          `[worker] posting diarization request ${requestId} with ${sampleCount} samples (${sampleDurationSeconds.toFixed(3)}s).`,
        );
        worker.postMessage(request, [samples.buffer]);
        appendEngineLog(`[worker] posted diarization request ${requestId}.`);
      });

      const normalizedTurns = renumberSpeakersSequentially(turns);

      await repo.saveArtifact(selectedMeeting.id, 'diarization', normalizedTurns);
      await repo.deleteArtifact(selectedMeeting.id, 'word-sync');
      await repo.deleteArtifact(selectedMeeting.id, 'speaker-names');
      await refreshMeetings(repo);
      setArtifactRevision((current) => current + 1);

      setEngineStatus('idle');
      setEngineMessage(
        `Diarization completed: ${normalizedTurns.length} speaker turn${normalizedTurns.length === 1 ? '' : 's'} detected.`,
      );
    } catch (error) {
      setEngineStatus('error');
      const message =
        error instanceof Error ? error.message : 'Diarization failed.';
      setEngineMessage(message);
      appendEngineLog(`[error] ${message}`);
      console.error('[engine] diarization failed', error);
    }
  }

  async function handleRunWordSync(meetingId: string) {
    const repo = meetingsRepoRef.current;
    const meeting = meetings.find((m) => m.id === meetingId);

    if (repo === null || meeting === undefined) {
      setEngineMessage('Select a stored meeting first.');
      return;
    }

    if (!meeting.artifacts.transcript || !meeting.artifacts.diarization) {
      setEngineMessage('Generate transcript and diarization first.');
      return;
    }

    if (getActiveModelVersion('text-audio-sync') === undefined) {
      setEngineMessage('Download a Wav2Vec2 model first.');
      return;
    }

    setEngineStatus('processing');
    setLiveTranscriptMeetingId(null);
    setEngineMessage(`Aligning words for ${meeting.name}...`);
    setEngineLog([`Starting word-sync for ${meeting.name}.`]);

    try {
      await repo.deleteArtifact(meetingId, 'word-sync');
      await repo.deleteArtifact(meetingId, 'speaker-names');
      await refreshMeetings(repo);
      setArtifactRevision((current) => current + 1);

      const transcript = await repo.loadArtifact<Transcript>(
        meetingId,
        'transcript',
      );
      if (transcript === null) {
        throw new Error('Transcript artifact missing.');
      }

      const audioFile = await repo.loadRecording(meetingId);
      const samples = await decodeAudioBlobToMonoFloat32(
        audioFile,
        WHISPER_SAMPLE_RATE,
        appendEngineLog,
      );

      const worker = getEngineWorker();
      const requestId = ++engineRequestIdRef.current;

      const words = await new Promise<unknown[]>((resolve, reject) => {
        const handleMessage = (event: MessageEvent<EngineWorkerResponse>) => {
          const msg = event.data;
          if (msg.id !== requestId) return;
          if (handleWorkerUpdate(msg)) return;
          if (msg.type !== 'result') return;
          worker.removeEventListener('message', handleMessage);
          if (msg.ok) {
            if (msg.mode !== 'word-sync') {
              reject(new Error('Worker returned an unexpected result.'));
              return;
            }
            resolve(msg.words);
          } else {
            reject(new Error(msg.error));
          }
        };

        worker.addEventListener('message', handleMessage);
        const request: EngineWorkerRequest = {
          id: requestId,
          mode: 'word-sync',
          fileName: meeting.name,
          audio: samples,
          audioSampleRate: WHISPER_SAMPLE_RATE,
          useWebGpu: webGpuSupport === 'supported',
          transcript,
        };
        worker.postMessage(request, [samples.buffer]);
      });

      await repo.saveArtifact(meetingId, 'word-sync', words);
      await repo.deleteArtifact(meetingId, 'speaker-names');
      await refreshMeetings(repo);
      setArtifactRevision((current) => current + 1);
      setEngineStatus('idle');
      setEngineMessage(
        `Word sync completed for ${meeting.name} (${words.length} words).`,
      );
    } catch (error) {
      setEngineStatus('error');
      const message =
        error instanceof Error ? error.message : 'Word sync failed.';
      setEngineMessage(message);
      appendEngineLog(`[error] ${message}`);
      console.error('[engine] word sync failed', error);
    }
  }

  async function handleRunSpeakerNaming(meetingId: string) {
    const repo = meetingsRepoRef.current;
    const meeting = meetings.find((m) => m.id === meetingId);

    if (repo === null || meeting === undefined) {
      setEngineMessage('Select a stored meeting first.');
      return;
    }

    if (!meeting.artifacts['word-sync']) {
      setEngineMessage('Generate word sync first.');
      return;
    }

    if (getActiveModelVersion('language') === undefined) {
      setEngineMessage('Download a Gemma 4 model first.');
      return;
    }

    setEngineStatus('processing');
    setLiveTranscriptMeetingId(null);
    setEngineMessage(`Naming speakers for ${meeting.name}...`);
    setEngineLog([`Starting speaker naming for ${meeting.name}.`]);

    try {
      await repo.deleteArtifact(meetingId, 'speaker-names');
      await refreshMeetings(repo);
      setArtifactRevision((current) => current + 1);

      const transcript = await repo.loadArtifact<Transcript>(
        meetingId,
        'transcript',
      );
      const turns = await repo.loadArtifact<SpeakerTurn[]>(
        meetingId,
        'diarization',
      );
      if (transcript === null || turns === null) {
        throw new Error('Transcript or diarization artifact missing.');
      }

      const audioFile = await repo.loadRecording(meetingId);
      const samples = await decodeAudioBlobToMonoFloat32(
        audioFile,
        WHISPER_SAMPLE_RATE,
        appendEngineLog,
      );

      const worker = getEngineWorker();
      const requestId = ++engineRequestIdRef.current;

      const names = await new Promise<Record<string, string>>(
        (resolve, reject) => {
          const handleMessage = (event: MessageEvent<EngineWorkerResponse>) => {
            const msg = event.data;
            if (msg.id !== requestId) return;
            if (handleWorkerUpdate(msg)) return;
            if (msg.type !== 'result') return;
            worker.removeEventListener('message', handleMessage);
            if (msg.ok) {
              if (msg.mode !== 'speaker-naming') {
                reject(new Error('Worker returned an unexpected result.'));
                return;
              }
              resolve(msg.names);
            } else {
              reject(new Error(msg.error));
            }
          };

          worker.addEventListener('message', handleMessage);
          const request: EngineWorkerRequest = {
            id: requestId,
            mode: 'speaker-naming',
            fileName: meeting.name,
            audio: samples,
            useWebGpu: webGpuSupport === 'supported',
            transcript,
            diarization: turns,
          };
          worker.postMessage(request, [samples.buffer]);
        },
      );

      await repo.saveArtifact(meetingId, 'speaker-names', names);
      await refreshMeetings(repo);
      setArtifactRevision((current) => current + 1);
      setEngineStatus('idle');
      setEngineMessage(`Speaker naming completed for ${meeting.name}.`);
    } catch (error) {
      setEngineStatus('error');
      const message =
        error instanceof Error ? error.message : 'Speaker naming failed.';
      setEngineMessage(message);
      appendEngineLog(`[error] ${message}`);
      console.error('[engine] speaker naming failed', error);
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
          {(
            [
              ['models', 'Models', `${activeModelCount}/4 active`],
              ['meetings', 'Meetings', `${meetings.length} saved`],
            ] as const
          ).map(([page, label, detail]) => (
            <NavLink
              key={page}
              to={PAGE_PATHS[page]}
              data-active={activePage === page}
            >
              <span>{label}</span>
              <small>{detail}</small>
            </NavLink>
          ))}
        </nav>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.hero}>
          <h1>
            {activePage === 'models'
              ? 'Models'
              : 'Meetings'}
          </h1>
          <p>
            {activePage === 'models'
              ? 'Download and activate the local Whisper, Pyannote, and Gemma models.'
              : 'Capture, transcribe, and review meetings stored locally in OPFS.'}
          </p>
        </header>

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

        {activePage === 'meetings' && viewingMeetingId !== null
          ? (() => {
              const viewedMeeting = meetings.find(
                (meeting) => meeting.id === viewingMeetingId,
              );

              if (viewedMeeting === undefined) {
                return (
                  <section className={styles.panel}>
                    <p className={styles.empty}>Meeting not found.</p>
                    <div className={styles.actions}>
                      <button
                        type="button"
                        onClick={() => navigate('/meetings')}
                      >
                        Back to meetings
                      </button>
                    </div>
                  </section>
                );
              }

              return (
                <MeetingDetailPage
                  meeting={viewedMeeting}
                  meetingUrl={meetingUrls[viewedMeeting.id]}
                  isRecording={recordingMeetingId === viewedMeeting.id}
                  status={status}
                  engineStatus={engineStatus}
                  engineMessage={engineMessage}
                  artifactRevision={artifactRevision}
                  liveTranscriptSegments={
                    engineStatus === 'processing' &&
                    liveTranscriptMeetingId === viewedMeeting.id
                      ? liveTranscriptSegments
                      : []
                  }
                  loadArtifact={loadMeetingArtifact}
                  saveArtifact={saveMeetingArtifact}
                  deleteArtifact={deleteMeetingArtifact}
                  onUpdateMeeting={(id, patch) =>
                    void handleUpdateMeeting(id, patch)
                  }
                  onStartRecording={() =>
                    void handleStartRecording(viewedMeeting.id)
                  }
                  onStopRecording={() => void handleStopRecording()}
                  onCancelRecording={handleCancelRecording}
                  onUploadRecording={(file) =>
                    void handleUploadRecording(viewedMeeting.id, file)
                  }
                  onDeleteMeeting={() =>
                    void handleDeleteMeeting(viewedMeeting)
                  }
                  onRunTranscript={() =>
                    void handleRunTranscription(viewedMeeting.id)
                  }
                  onRunDiarization={() =>
                    void handleRunDiarization(viewedMeeting.id)
                  }
                  onRunWordSync={() => void handleRunWordSync(viewedMeeting.id)}
                  onRunSpeakerNaming={() =>
                    void handleRunSpeakerNaming(viewedMeeting.id)
                  }
                  onOpenLogging={(mode) => {
                    setEngineDialogMode(mode);
                    setEngineDialogOpen(true);
                  }}
                  onBack={() => navigate('/meetings')}
                  formatBytes={formatBytes}
                  formatDate={formatDate}
                  formatTimestamp={formatTimestamp}
                />
              );
            })()
          : null}

        {activePage === 'meetings' && viewingMeetingId === null ? (
          <MeetingsPage
            meetings={meetings}
            message={message}
            isCreating={creatingMeeting}
            onCreateMeeting={() => void handleCreateMeeting()}
            onOpenMeeting={(meeting) => navigate(`/meetings/${meeting.id}`)}
            formatDate={formatDate}
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
                  {meetings.find((m) => m.id === selectedMeetingId)?.name ?? ''}
                </h2>
              </div>
              <span data-state={engineStatus}>{engineStatus}</span>
            </div>

            {engineDialogMode === 'transcription' ? (
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
            ) : null}

            <div ref={engineLogRef} className={styles.engineLog}>
              {engineLog.length === 0 ? (
                <p className={styles.empty}>Waiting for output...</p>
              ) : (
                engineLog.map((line, index) => (
                  <p key={`${index}-${line.slice(0, 32)}`}>{line}</p>
                ))
              )}
            </div>

            <button type="button" onClick={() => setEngineDialogOpen(false)}>
              {engineStatus === 'processing' ? 'Hide' : 'Close'}
            </button>
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
