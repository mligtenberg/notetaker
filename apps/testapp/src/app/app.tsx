import { useEffect, useRef, useState } from 'react';
import { load_audio, pipeline } from '@huggingface/transformers';
import { AudioRecorder, type AudioRecordingResult } from '@notetaker/audio-recorder';
import {
  Engine,
  type Meeting,
  type MeetingNotes,
  type SpeakerDiarizationEngine,
  type SpeakerNamingInput,
  type SpeakerNamingModel,
  type SpeakerNameGuess,
  type TranscriptionEngine,
  type Transcript,
} from '@notetaker/engine';
import { FileSystem } from '@notetaker/filesystem';
import {
  ModelManager,
  type ManagedModel,
  type ModelVersionManifestEntry,
} from '@notetaker/model-manager';
import styles from './app.module.css';

interface StoredAudioFile {
  name: string;
  size: number;
  type: string;
  updatedAt: number;
  url: string;
  fileHandle: FileSystemFileHandle;
}

type RecorderStatus = 'idle' | 'ready' | 'recording' | 'saving' | 'error';
type EngineStatus = 'idle' | 'processing' | 'error';
type AppPage = 'models' | 'recordings' | 'engine';
type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
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
type WhisperTranscriber = (
  audio: Float32Array,
  options?: {
    chunk_length_s?: number;
    return_timestamps?: boolean;
    task?: string;
  },
) => Promise<{
  text: string;
  chunks?: { text: string; timestamp: [number, number] }[];
}>;

const MODEL_DOWNLOAD_TARGETS: ModelDownloadTarget[] = [
  {
    model: 'whisper',
    label: 'Whisper',
    description: 'Transcription model. Searches Whisper and Faster-Whisper repositories.',
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
    description: 'Speaker naming model. Filters E2B, E4B, 31B, 26B, A4B with BF16, SFP8, or Q4_0.',
    defaultSearch: 'gemma',
  },
];

const GEMMA_SIZE_LABELS = ['e2b', 'e4b', '31b', '26b', 'a4b'] as const;
const GEMMA_QUANT_LABELS = ['bf16', 'sfp8', 'q4_0'] as const;
const MODEL_FILE_EXTENSIONS = ['.safetensors', '.gguf', '.onnx', '.bin', '.pt', '.pth'] as const;

const WHISPER_ONNX_DOWNLOADS: DirectModelDownload[] = [
  createWhisperOnnxDownload('Xenova/whisper-tiny', 'Tiny ONNX', 'Fastest browser/local test model.'),
  createWhisperOnnxDownload('Xenova/whisper-base', 'Base ONNX', 'Good default for local prototype runs.'),
  createWhisperOnnxDownload('Xenova/whisper-small', 'Small ONNX', 'Better quality with a larger download.'),
];
const PYANNOTE_DOWNLOADS: DirectModelDownload[] = [
  {
    id: 'onnx-community/pyannote-segmentation-3.0',
    label: 'Segmentation 3.0 ONNX',
    description: 'Token-free ONNX segmentation model for speech activity and speaker-change building blocks.',
    model: 'pyannote',
    files: ['config.json', 'preprocessor_config.json', 'onnx/model.onnx'].map((path) => ({
      path,
      url: buildHuggingFaceDownloadUrl('onnx-community/pyannote-segmentation-3.0', path),
      type: path.endsWith('.onnx') ? 'application/octet-stream' : 'application/json',
    })),
  },
  {
    id: 'deepghs/pyannote-embedding-onnx',
    label: 'Embedding ONNX',
    description: 'Token-free ONNX speaker embedding model for clustering speaker turns.',
    model: 'pyannote',
    files: ['model.onnx', 'README.md'].map((path) => ({
      path,
      url: buildHuggingFaceDownloadUrl('deepghs/pyannote-embedding-onnx', path),
      type: path.endsWith('.onnx') ? 'application/octet-stream' : 'text/plain',
    })),
  },
];
const GEMMA_DOWNLOADS: DirectModelDownload[] = [
  createDirectModelDownload({
    id: 'google/gemma-4-E2B-it',
    label: 'Google E2B IT',
    description: 'Official Google Gemma 4 E2B instruct BF16 safetensors preset.',
    model: 'gemma4',
    files: [
      'chat_template.jinja',
      'config.json',
      'generation_config.json',
      'model.safetensors',
      'processor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ],
  }),
  createDirectModelDownload({
    id: 'google/gemma-4-E4B-it',
    label: 'Google E4B IT',
    description: 'Official Google Gemma 4 E4B instruct BF16 safetensors preset.',
    model: 'gemma4',
    files: [
      'chat_template.jinja',
      'config.json',
      'generation_config.json',
      'model.safetensors',
      'processor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ],
  }),
  createDirectModelDownload({
    id: 'google/gemma-4-26B-A4B-it',
    label: 'Google 26B A4B IT',
    description: 'Official Google Gemma 4 26B/A4B instruct BF16 safetensors preset.',
    model: 'gemma4',
    files: [
      'chat_template.jinja',
      'config.json',
      'generation_config.json',
      'model-00001-of-00002.safetensors',
      'model-00002-of-00002.safetensors',
      'model.safetensors.index.json',
      'processor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ],
  }),
  createDirectModelDownload({
    id: 'google/gemma-4-31B-it',
    label: 'Google 31B IT',
    description: 'Official Google Gemma 4 31B instruct BF16 safetensors preset.',
    model: 'gemma4',
    files: [
      'chat_template.jinja',
      'config.json',
      'generation_config.json',
      'model-00001-of-00002.safetensors',
      'model-00002-of-00002.safetensors',
      'model.safetensors.index.json',
      'processor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ],
  }),
  createDirectModelDownload({
    id: 'unsloth/gemma-4-E2B-it-GGUF',
    label: 'E2B Q4_0 GGUF',
    description: 'Quantized Gemma 4 E2B instruct preset based on google/gemma-4-E2B-it.',
    model: 'gemma4',
    files: ['config.json', 'gemma-4-E2B-it-Q4_0.gguf'],
  }),
  createDirectModelDownload({
    id: 'unsloth/gemma-4-E4B-it-GGUF',
    label: 'E4B Q4_0 GGUF',
    description: 'Quantized Gemma 4 E4B instruct preset based on google/gemma-4-E4B-it.',
    model: 'gemma4',
    files: ['config.json', 'gemma-4-E4B-it-Q4_0.gguf'],
  }),
  createDirectModelDownload({
    id: 'bartowski/google_gemma-4-26B-A4B-it-GGUF',
    label: '26B A4B Q4_0 GGUF',
    description: 'Quantized Gemma 4 26B/A4B instruct preset based on google/gemma-4-26B-A4B-it.',
    model: 'gemma4',
    files: ['README.md', 'google_gemma-4-26B-A4B-it-Q4_0.gguf'],
  }),
  createDirectModelDownload({
    id: 'unsloth/gemma-4-31B-it-GGUF',
    label: '31B Q4_0 GGUF',
    description: 'Quantized Gemma 4 31B instruct preset based on google/gemma-4-31B-it.',
    model: 'gemma4',
    files: ['config.json', 'gemma-4-31B-it-Q4_0.gguf'],
  }),
  createDirectModelDownload({
    id: 'onnx-community/gemma-4-E2B-it-ONNX',
    label: 'E2B Q4 ONNX',
    description: 'Quantized ONNX text-generation files for browser/WebGPU testing.',
    model: 'gemma4',
    files: [
      'chat_template.jinja',
      'config.json',
      'generation_config.json',
      'onnx/decoder_model_merged_q4.onnx',
      'onnx/decoder_model_merged_q4.onnx_data',
      'onnx/embed_tokens_q4.onnx',
      'onnx/embed_tokens_q4.onnx_data',
      'processor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ],
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

function isFileHandle(handle: FileSystemHandle): handle is FileSystemFileHandle {
  return handle.kind === 'file';
}

const fileSystem = new FileSystem();
const WHISPER_SAMPLE_RATE = 16_000;
const whisperTranscribers = new Map<string, Promise<WhisperTranscriber>>();

class ActiveModelTranscriptionEngine implements TranscriptionEngine {
  readonly #modelManager: ModelManager;

  constructor(modelManager: ModelManager) {
    this.#modelManager = modelManager;
  }

  async transcribe(meeting: Meeting): Promise<Transcript> {
    const activeModel = await this.#requireActiveModel('whisper');
    const modelId = this.#getHuggingFaceModelId(activeModel);
    const transcriber = await this.#getTranscriber(modelId);
    const audio = await decodeMeetingAudio(meeting.audio);
    const output = await transcriber(audio, {
      chunk_length_s: 30,
      return_timestamps: true,
      task: 'transcribe',
    });
    const segments = output.chunks?.map((chunk) => ({
      text: chunk.text.trim(),
      startSeconds: chunk.timestamp[0],
      endSeconds: chunk.timestamp[1],
    })).filter((segment) => segment.text.length > 0);

    return {
      text: output.text.trim(),
      segments: segments?.length === undefined || segments.length === 0
        ? [
            {
              text: output.text.trim(),
              startSeconds: 0,
              endSeconds: Math.max(1, audio.length / WHISPER_SAMPLE_RATE),
            },
          ]
        : segments,
    };
  }

  async #getTranscriber(modelId: string): Promise<WhisperTranscriber> {
    let transcriber = whisperTranscribers.get(modelId);

    if (transcriber === undefined) {
      transcriber = pipeline('automatic-speech-recognition', modelId, {
        device: 'wasm',
        dtype: {
          encoder_model: 'fp32',
          decoder_model_merged: 'fp32',
        },
        session_options: {
          graphOptimizationLevel: 'disabled',
        },
      }).then(
        (loadedPipeline) => loadedPipeline as WhisperTranscriber,
      );
      whisperTranscribers.set(modelId, transcriber);
    }

    return transcriber;
  }

  #getHuggingFaceModelId(model: ModelVersionManifestEntry): string {
    const modelId = model.metadata?.['huggingFaceModelId'];

    if (typeof modelId !== 'string' || modelId.length === 0) {
      throw new Error('Active Whisper model is missing Hugging Face model metadata. Re-download a Whisper ONNX preset.');
    }

    return modelId;
  }

  async #requireActiveModel(model: ManagedModel): Promise<ModelVersionManifestEntry> {
    const activeModel = await this.#modelManager.getActiveVersion(model);

    if (activeModel === null) {
      throw new Error(`Download and activate a ${model} model first.`);
    }

    return activeModel.manifest;
  }
}

class ActiveModelSpeakerDiarizationEngine implements SpeakerDiarizationEngine {
  readonly #modelManager: ModelManager;

  constructor(modelManager: ModelManager) {
    this.#modelManager = modelManager;
  }

  async diarize(): Promise<{ speaker: string; startSeconds: number; endSeconds: number }[]> {
    await this.#requireActiveModel('pyannote');

    return [
      {
        speaker: 'speaker-1',
        startSeconds: 0,
        endSeconds: Number.POSITIVE_INFINITY,
      },
    ];
  }

  async #requireActiveModel(model: ManagedModel): Promise<void> {
    const activeModel = await this.#modelManager.getActiveVersion(model);

    if (activeModel === null) {
      throw new Error(`Download and activate a ${model} model first.`);
    }
  }
}

class ActiveModelSpeakerNamingModel implements SpeakerNamingModel {
  readonly #modelManager: ModelManager;

  constructor(modelManager: ModelManager) {
    this.#modelManager = modelManager;
  }

  async nameSpeakers(_input: SpeakerNamingInput): Promise<SpeakerNameGuess[]> {
    const activeModel = await this.#modelManager.getActiveVersion('gemma4');

    if (activeModel === null) {
      throw new Error('Download and activate a gemma4 model first.');
    }

    return [];
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

async function decodeMeetingAudio(audio: Meeting['audio']): Promise<Float32Array> {
  const blob = audio instanceof Blob
    ? audio
    : audio instanceof Uint8Array
      ? new Blob([new Uint8Array(audio).buffer])
      : new Blob([audio]);
  const url = URL.createObjectURL(blob);

  try {
    return await load_audio(url, WHISPER_SAMPLE_RATE);
  } finally {
    URL.revokeObjectURL(url);
  }
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

function createWhisperOnnxDownload(
  repositoryId: string,
  label: string,
  description: string,
): DirectModelDownload {
  const files = [
    'config.json',
    'generation_config.json',
    'preprocessor_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'vocab.json',
    'merges.txt',
    'onnx/encoder_model.onnx',
    'onnx/decoder_model_merged.onnx',
  ];

  return {
    id: repositoryId,
    label,
    description,
    model: 'whisper',
    files: files.map((path) => ({
      path,
      url: buildHuggingFaceDownloadUrl(repositoryId, path),
      type: path.endsWith('.onnx') ? 'application/octet-stream' : 'application/json',
    })),
  };
}

function createDirectModelDownload(options: {
  id: string;
  label: string;
  description: string;
  model: ManagedModel;
  files: string[];
}): DirectModelDownload {
  return {
    id: options.id,
    label: options.label,
    description: options.description,
    model: options.model,
    files: options.files.map((path) => ({
      path,
      url: buildHuggingFaceDownloadUrl(options.id, path),
      type: resolveModelFileType(path),
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
    throw new Error(`Download failed for ${file.path} with ${response.status} ${response.statusText}.`);
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

    chunks.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    loadedBytes += value.byteLength;
    onProgress(loadedBytes, normalizedTotalBytes);
  }

  return new Blob(chunks, { type: file.type });
}

function getModelSearchText(model: HuggingFaceModel): string {
  return [model.id, ...(model.tags ?? [])].join(' ').toLowerCase();
}

function supportsTargetModel(model: ManagedModel, huggingFaceModel: HuggingFaceModel): boolean {
  const text = getModelSearchText(huggingFaceModel);

  if (model === 'whisper') {
    return text.includes('whisper') || text.includes('faster-whisper') || text.includes('fast-whisper');
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
        MODEL_FILE_EXTENSIONS.some((extension) => lowerFileName.endsWith(extension))
      );
    })
    .sort((first, second) => first.localeCompare(second));
}

function buildHuggingFaceDownloadUrl(modelId: string, fileName: string): string {
  return `https://huggingface.co/${modelId}/resolve/main/${fileName
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

async function searchHuggingFaceModels(
  target: ModelDownloadTarget,
  query: string,
): Promise<HuggingFaceModel[]> {
  const queries = target.model === 'whisper' ? [query, 'faster-whisper', 'fast-whisper'] : [query];
  const models = new Map<string, HuggingFaceModel>();

  for (const searchQuery of queries) {
    const params = new URLSearchParams({
      search: searchQuery,
      limit: '20',
      full: 'true',
      sort: 'downloads',
      direction: '-1',
    });
    const response = await fetch(`https://huggingface.co/api/models?${params.toString()}`);

    if (!response.ok) {
      throw new Error(`Hugging Face search failed with ${response.status} ${response.statusText}.`);
    }

    const results = (await response.json()) as HuggingFaceModel[];
    for (const model of results) {
      if (supportsTargetModel(target.model, model) && getDownloadableFiles(model).length > 0) {
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
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [engineStatus, setEngineStatus] = useState<EngineStatus>('idle');
  const [message, setMessage] = useState('Opening OPFS audio-files folder...');
  const [modelMessage, setModelMessage] = useState('Opening OPFS models folder...');
  const [engineMessage, setEngineMessage] = useState('Select a recording and run the engine.');
  const [files, setFiles] = useState<StoredAudioFile[]>([]);
  const [lastRecording, setLastRecording] = useState<AudioRecordingResult | null>(null);
  const [modelSearches, setModelSearches] = useState<ModelSearchStates>(INITIAL_MODEL_SEARCHES);
  const [modelVersions, setModelVersions] = useState<ModelVersionManifestEntry[]>([]);
  const [downloadingModel, setDownloadingModel] = useState<ManagedModel | null>(null);
  const [selectedAudioName, setSelectedAudioName] = useState('');
  const [meetingNotes, setMeetingNotes] = useState<MeetingNotes | null>(null);
  const [activePage, setActivePage] = useState<AppPage>('models');
  const [remoteFileSizes, setRemoteFileSizes] = useState<Record<string, number | null>>({});
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressState | null>(null);

  useObjectUrlCleanup(files);

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

  function getKnownDownloadSize(download: DirectModelDownload): number | null | undefined {
    let total = 0;

    for (const file of download.files) {
      const size = getKnownFileSize(file.url);

      if (size === undefined) {
        return undefined;
      }

      if (size === null) {
        return null;
      }

      total += size;
    }

    return total;
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
        setModelMessage('Ready. Search Hugging Face and cache model files in OPFS/models.');
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setStatus('error');
        setMessage(error instanceof Error ? error.message : 'Failed to open OPFS audio-files folder.');
        setModelMessage(error instanceof Error ? error.message : 'Failed to open OPFS models folder.');
      }
    }

    void setupRecorder();

    return () => {
      isMounted = false;
      recorderRef.current?.cancel();
    };
  }, []);

  useEffect(() => {
    if (activePage !== 'models') {
      return;
    }

    ensureRemoteFileSizes(
      [...WHISPER_ONNX_DOWNLOADS, ...PYANNOTE_DOWNLOADS, ...GEMMA_DOWNLOADS].flatMap((download) =>
        download.files.map((file) => file.url),
      ),
    );
  }, [activePage, remoteFileSizes]);

  useEffect(() => {
    if (activePage !== 'models') {
      return;
    }

    const selectedUrls = MODEL_DOWNLOAD_TARGETS.flatMap((target) =>
      modelSearches[target.model].results.flatMap((result) => {
        const selectedFile = modelSearches[target.model].selectedFiles[result.id];
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
      setMessage('Recording. Stop to persist the audio file in OPFS/audio-files.');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Failed to start recording.');
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
      setMessage(error instanceof Error ? error.message : 'Failed to save recording.');
    }
  }

  async function handleUploadRecordings(filesToUpload: FileList | null) {
    const directoryHandle = directoryHandleRef.current;

    if (directoryHandle === null || filesToUpload === null || filesToUpload.length === 0) {
      return;
    }

    try {
      setStatus('saving');
      setMessage(`Importing ${filesToUpload.length} audio file${filesToUpload.length === 1 ? '' : 's'}...`);

      for (const file of Array.from(filesToUpload)) {
        const fileHandle = await directoryHandle.getFileHandle(file.name, { create: true });
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
      setMessage(`Imported ${filesToUpload.length} audio file${filesToUpload.length === 1 ? '' : 's'} into OPFS/audio-files.`);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Failed to import audio files.');
    }
  }

  function handleCancelRecording() {
    recorderRef.current?.cancel();
    setStatus('ready');
    setMessage('Recording canceled. No audio file was stored.');
  }

  function updateModelSearch(model: ManagedModel, update: Partial<ModelSearchState>) {
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

  function handleSelectedModelFileChange(model: ManagedModel, modelId: string, fileName: string) {
    updateModelSearch(model, {
      selectedFiles: {
        ...modelSearches[model].selectedFiles,
        [modelId]: fileName,
      },
    });
  }

  async function handleSearchModels(target: ModelDownloadTarget) {
    const query = modelSearches[target.model].query.trim() || target.defaultSearch;

    try {
      updateModelSearch(target.model, { searching: true });
      setModelMessage(`Searching Hugging Face for ${target.label}...`);

      const results = await searchHuggingFaceModels(target, query);
      const selectedFiles = Object.fromEntries(
        results.map((result) => [result.id, getDownloadableFiles(result)[0] ?? '']),
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
      setModelMessage(error instanceof Error ? error.message : `Failed to search ${target.label}.`);
    }
  }

  async function handleDownloadModel(
    target: ModelDownloadTarget,
    huggingFaceModel: HuggingFaceModel,
  ) {
    const modelManager = modelManagerRef.current;
    const fileName = modelSearches[target.model].selectedFiles[huggingFaceModel.id];

    if (modelManager === null || fileName === undefined || fileName.length === 0) {
      setModelMessage('Select a model file first.');
      return;
    }

    try {
      setDownloadingModel(target.model);
      setModelMessage(`Downloading ${target.label} from ${huggingFaceModel.id}...`);

      const url = buildHuggingFaceDownloadUrl(huggingFaceModel.id, fileName);
      const directFile: DirectModelFile = {
        path: fileName,
        url,
        type: resolveModelFileType(fileName),
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
      const file = await downloadBlobWithProgress(directFile, (loadedBytes, totalBytes) => {
        setDownloadProgress({
          title: `Downloading ${target.label}`,
          currentFile: fileName,
          fileIndex: 1,
          fileCount: 1,
          loadedBytes,
          totalBytes,
          status: 'downloading',
        });
      });
      const version = `${huggingFaceModel.id.replaceAll('/', '__')}--${new Date()
        .toISOString()
        .replaceAll(':', '-')}`;

      setDownloadProgress((currentProgress) =>
        currentProgress === null ? null : { ...currentProgress, status: 'saving' },
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
          huggingFaceModelId: huggingFaceModel.id,
          huggingFaceFile: fileName,
          sourceUrl: url,
        },
      });

      await refreshModelVersions(modelManager);
      setDownloadProgress((currentProgress) =>
        currentProgress === null ? null : { ...currentProgress, status: 'complete' },
      );
      setModelMessage(`Downloaded and activated ${target.label} ${version}.`);
    } catch (error) {
      setDownloadProgress((currentProgress) =>
        currentProgress === null ? null : { ...currentProgress, status: 'error' },
      );
      setModelMessage(error instanceof Error ? error.message : `Failed to download ${target.label}.`);
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

        const blob = await downloadBlobWithProgress(file, (loadedBytes, fileTotalBytes) => {
          const fallbackTotalBytes = knownTotalBytes ?? completedBytes + (fileTotalBytes ?? loadedBytes);
          setDownloadProgress({
            title: `Downloading ${download.label}`,
            currentFile: file.path,
            fileIndex: index + 1,
            fileCount: download.files.length,
            loadedBytes: completedBytes + loadedBytes,
            totalBytes: fallbackTotalBytes,
            status: 'downloading',
          });
        });

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
        currentProgress === null ? null : { ...currentProgress, status: 'saving' },
      );

      await modelManager.addVersion({
        model: download.model,
        version,
        activate: true,
        files,
        metadata: {
          format: download.model === 'gemma4' ? 'direct-hugging-face' : 'onnx',
          huggingFaceModelId: download.id,
          sourceUrls: download.files.map((file) => file.url),
          gated: false,
        },
      });

      await refreshModelVersions(modelManager);
      setDownloadProgress((currentProgress) =>
        currentProgress === null ? null : { ...currentProgress, status: 'complete' },
      );
      setModelMessage(`Downloaded and activated ${download.label}.`);
    } catch (error) {
      setDownloadProgress((currentProgress) =>
        currentProgress === null ? null : { ...currentProgress, status: 'error' },
      );
      setModelMessage(error instanceof Error ? error.message : `Failed to download ${download.label}.`);
    } finally {
      setDownloadingModel(null);
    }
  }

  async function handleRunEngine() {
    const modelManager = modelManagerRef.current;
    const selectedFile = files.find((file) => file.name === selectedAudioName);

    if (modelManager === null || selectedFile === undefined) {
      setEngineMessage('Select a stored recording first.');
      return;
    }

    try {
      setEngineStatus('processing');
      setEngineMessage(`Processing ${selectedFile.name}...`);
      const audio = await selectedFile.fileHandle.getFile();
      const engine = new Engine({
        transcription: new ActiveModelTranscriptionEngine(modelManager),
        diarization: new ActiveModelSpeakerDiarizationEngine(modelManager),
        speakerNaming: new ActiveModelSpeakerNamingModel(modelManager),
      });
      const notes = await engine.processMeeting({
        id: selectedFile.name,
        title: selectedFile.name,
        audio,
      });

      setMeetingNotes(notes);
      setEngineStatus('idle');
      setEngineMessage(`Engine completed for ${selectedFile.name}.`);
    } catch (error) {
      setEngineStatus('error');
      setEngineMessage(error instanceof Error ? error.message : 'Engine processing failed.');
    }
  }

  function getActiveModelVersion(model: ManagedModel): ModelVersionManifestEntry | undefined {
    return modelVersions.find((version) => version.model === model && version.active);
  }

  const activeModelCount = MODEL_DOWNLOAD_TARGETS.filter(
    (target) => getActiveModelVersion(target.model) !== undefined,
  ).length;
  const downloadPercent = downloadProgress?.totalBytes
    ? Math.min(100, Math.round((downloadProgress.loadedBytes / downloadProgress.totalBytes) * 100))
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
                : 'Run the engine pipeline'}
          </h1>
          <p>
            {activePage === 'models'
              ? 'Search Hugging Face, download model files, and activate them in OPFS before processing meetings.'
              : activePage === 'recordings'
                ? 'Record microphone audio directly into OPFS and keep a small local library for engine testing.'
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
              <span>{modelVersions.length} version{modelVersions.length === 1 ? '' : 's'}</span>
            </div>
            <p className={styles.message}>{modelMessage}</p>

            <div className={styles.directDownloads}>
              <div>
                <p className={styles.label}>Direct ONNX downloads</p>
                <h3>Whisper presets</h3>
                <p>
                  These use Xenova Whisper ONNX repositories and download the encoder,
                  merged decoder, tokenizer, and config files into the active Whisper slot.
                </p>
              </div>
              <div className={styles.presetGrid}>
                {WHISPER_ONNX_DOWNLOADS.map((download) => (
                  <article key={download.id}>
                    <strong>{download.label}</strong>
                    <span>{download.id}</span>
                    <span>{formatOptionalBytes(getKnownDownloadSize(download))}</span>
                    <p>{download.description}</p>
                    <button
                      type="button"
                      onClick={() => void handleDownloadDirectModel(download)}
                      disabled={downloadingModel !== null}
                    >
                      {downloadingModel === 'whisper' ? 'Downloading...' : 'Download ONNX'}
                    </button>
                  </article>
                ))}
              </div>
            </div>

            <div className={styles.directDownloads}>
              <div>
                <p className={styles.label}>Direct Pyannote ONNX downloads</p>
                <h3>Token-free diarization building blocks</h3>
                <p>
                  These community ONNX exports do not require a Hugging Face token. Download
                  segmentation and embedding models to prepare a local diarization pipeline.
                </p>
              </div>
              <div className={styles.presetGrid}>
                {PYANNOTE_DOWNLOADS.map((download) => (
                  <article key={download.id}>
                    <strong>{download.label}</strong>
                    <span>{download.id}</span>
                    <span>{formatOptionalBytes(getKnownDownloadSize(download))}</span>
                    <p>{download.description}</p>
                    <button
                      type="button"
                      onClick={() => void handleDownloadDirectModel(download)}
                      disabled={downloadingModel !== null}
                    >
                      {downloadingModel === 'pyannote' ? 'Downloading...' : 'Download Pyannote'}
                    </button>
                  </article>
                ))}
              </div>
            </div>

            <div className={styles.directDownloads}>
              <div>
                <p className={styles.label}>Direct Gemma 4 downloads</p>
                <h3>Official and quantized google/gemma-4 presets</h3>
                <p>
                  These direct buttons include official Google BF16 safetensors plus public
                  quantized GGUF/ONNX builds based on the matching google/gemma-4 models.
                </p>
              </div>
              <div className={styles.presetGrid}>
                {GEMMA_DOWNLOADS.map((download) => (
                  <article key={download.id}>
                    <strong>{download.label}</strong>
                    <span>{download.id}</span>
                    <span>{formatOptionalBytes(getKnownDownloadSize(download))}</span>
                    <p>{download.description}</p>
                    <button
                      type="button"
                      onClick={() => void handleDownloadDirectModel(download)}
                      disabled={downloadingModel !== null}
                    >
                      {downloadingModel === 'gemma4' ? 'Downloading...' : 'Download Gemma'}
                    </button>
                  </article>
                ))}
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
                      <span>Active: {activeModel === undefined ? 'none' : activeModel.version}</span>
                    </div>
                    <div className={styles.searchRow}>
                      <input
                        aria-label={`${target.label} Hugging Face search`}
                        type="search"
                        placeholder={target.defaultSearch}
                        value={search.query}
                        onChange={(event) => handleModelQueryChange(target.model, event.target.value)}
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
                          const selectedFile = search.selectedFiles[result.id] ?? files[0] ?? '';
                          const selectedFileUrl = selectedFile.length === 0
                            ? null
                            : buildHuggingFaceDownloadUrl(result.id, selectedFile);

                          return (
                            <li key={result.id}>
                              <div>
                                <strong>{result.id}</strong>
                                <span>
                                  {(result.downloads ?? 0).toLocaleString()} downloads | {(result.likes ?? 0).toLocaleString()} likes
                                </span>
                                <span>
                                  Selected file: {selectedFileUrl === null
                                    ? 'none'
                                    : formatOptionalBytes(getKnownFileSize(selectedFileUrl))}
                                </span>
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
                                  <option key={`${result.id}-${fileName}`} value={fileName}>
                                    {fileName}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                onClick={() => void handleDownloadModel(target, result)}
                                disabled={downloadingModel !== null}
                              >
                                {downloadingModel === target.model ? 'Downloading...' : 'Download & Activate'}
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
                <strong>Import MP3, WAV, M4A, WebM, or OGG files into OPFS/audio-files.</strong>
                <input
                  type="file"
                  accept="audio/*,.mp3,.m4a,.wav,.webm,.ogg"
                  multiple
                  onChange={(event) => {
                    void handleUploadRecordings(event.target.files);
                    event.currentTarget.value = '';
                  }}
                  disabled={status === 'idle' || status === 'recording' || status === 'saving'}
                />
              </label>

              <div className={styles.actions}>
                <button type="button" onClick={handleStartRecording} disabled={status !== 'ready'}>
                  Start Recording
                </button>
                <button type="button" onClick={handleStopRecording} disabled={status !== 'recording'}>
                  Stop & Save
                </button>
                <button type="button" onClick={handleCancelRecording} disabled={status !== 'recording'}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void refreshFiles()}
                  disabled={status === 'idle' || status === 'recording' || status === 'saving'}
                >
                  Refresh Files
                </button>
              </div>

              {lastRecording !== null ? (
                <p className={styles.saved}>
                  Last saved: <strong>{lastRecording.fileName}</strong> ({formatBytes(lastRecording.size)})
                </p>
              ) : null}
            </section>

            <section className={styles.panel}>
              <div className={styles.listHeader}>
                <div>
                  <p className={styles.label}>OPFS/audio-files</p>
                  <h2>Stored recordings</h2>
                </div>
                <span>{files.length} file{files.length === 1 ? '' : 's'}</span>
              </div>

              {files.length === 0 ? (
                <p className={styles.empty}>No recordings stored yet.</p>
              ) : (
                <ul className={styles.fileList}>
                  {files.map((file) => (
                    <li key={`${file.name}-${file.updatedAt}`}>
                      <div>
                        <strong>{file.name}</strong>
                        <span>{file.type} | {formatBytes(file.size)} | {formatDate(file.updatedAt)}</span>
                      </div>
                      <audio controls src={file.url} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
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
                disabled={selectedAudioName.length === 0 || engineStatus === 'processing'}
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

      {downloadProgress !== null ? (
        <div className={styles.downloadOverlay} role="dialog" aria-modal="true" aria-label="Download progress">
          <section className={styles.downloadDialog}>
            <div className={styles.listHeader}>
              <div>
                <p className={styles.label}>Download</p>
                <h2>{downloadProgress.title}</h2>
              </div>
              <span>{downloadProgress.status}</span>
            </div>
            <p className={styles.message}>
              File {downloadProgress.fileIndex} of {downloadProgress.fileCount}: {downloadProgress.currentFile}
            </p>
            <div className={styles.progressTrack}>
              <div style={{ width: `${downloadPercent ?? 8}%` }} />
            </div>
            <p className={styles.progressMeta}>
              {formatBytes(downloadProgress.loadedBytes)} / {downloadProgress.totalBytes === null ? 'unknown' : formatBytes(downloadProgress.totalBytes)}
              {downloadPercent === null ? '' : ` (${downloadPercent}%)`}
            </p>
            {downloadProgress.status === 'complete' || downloadProgress.status === 'error' ? (
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
