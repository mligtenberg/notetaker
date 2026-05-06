import {
  type ManagedModel,
  type ModelVersionManifestEntry,
} from '@notetaker/model-manager';
import {
  SUGGESTED_MODEL_DOWNLOADS_CONFIG,
  type SuggestedModelFileConfig,
  type SuggestedModelScores,
} from '../suggested-model-downloads.config';

export interface ModelDownloadTarget {
  model: ManagedModel;
  label: string;
  description: string;
}

export interface DirectModelFile {
  path: string;
  url: string;
  type: string;
  size: number;
}

export interface DirectModelDownload {
  id: string;
  repositoryName: string;
  label: string;
  description: string;
  model: ManagedModel;
  scores: SuggestedModelScores;
  quantization?: string;
  files: DirectModelFile[];
}

export interface DownloadSection {
  model: ManagedModel;
  title: string;
  description: string;
  downloads: DirectModelDownload[];
  buttonLabel: string;
  downloadingLabel: string;
}

export const MODEL_DOWNLOAD_TARGETS: ModelDownloadTarget[] = [
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

const SUGGESTED_MODEL_DOWNLOADS = createSuggestedModelDownloads();

interface RecommendedModelChoice {
  repositoryId: string;
  quantization: string;
}

export const RECOMMENDED_DOWNLOADS: Record<ManagedModel, RecommendedModelChoice> = {
  transcription: {
    repositoryId: 'onnx-community/whisper-base',
    quantization: 'q8',
  },
  diarization: {
    repositoryId: 'onnx-community/pyannote-segmentation-3.0',
    quantization: 'q8',
  },
  language: {
    repositoryId: 'onnx-community/gemma-4-E2B-it-ONNX',
    quantization: 'q4',
  },
  'text-audio-sync': {
    repositoryId: 'onnx-community/wav2vec2-base-960h-ONNX',
    quantization: 'q8',
  },
};

export function getRecommendedDownload(
  model: ManagedModel,
): DirectModelDownload | undefined {
  const choice = RECOMMENDED_DOWNLOADS[model];

  return SUGGESTED_MODEL_DOWNLOADS.find(
    (download) =>
      download.model === model &&
      download.id === choice.repositoryId &&
      download.quantization === choice.quantization,
  );
}

export const MODEL_DOWNLOAD_SECTIONS: DownloadSection[] = [
  {
    model: 'transcription',
    title: 'Transcription',
    description:
      'Converts meeting audio into written transcript text for notes, search, and review.',
    downloads: getSuggestedModelDownloads('transcription'),
    buttonLabel: 'Download',
    downloadingLabel: 'Downloading...',
  },
  {
    model: 'diarization',
    title: 'Speaker detection',
    description:
      'Finds when speakers change so transcript segments can be grouped by participant.',
    downloads: getSuggestedModelDownloads('diarization'),
    buttonLabel: 'Download',
    downloadingLabel: 'Downloading...',
  },
  {
    model: 'language',
    title: 'Speaker naming',
    description:
      'Infers likely participant names from meeting context and transcript content.',
    downloads: getSuggestedModelDownloads('language'),
    buttonLabel: 'Download',
    downloadingLabel: 'Downloading...',
  },
  {
    model: 'text-audio-sync',
    title: 'Text-audio sync',
    description:
      'Aligns transcript text back to the audio timeline for precise timestamps and playback navigation.',
    downloads: getSuggestedModelDownloads('text-audio-sync'),
    buttonLabel: 'Download',
    downloadingLabel: 'Downloading...',
  },
];

export function createSuggestedModelDownloads(): DirectModelDownload[] {
  return Object.entries(SUGGESTED_MODEL_DOWNLOADS_CONFIG).flatMap(
    ([repositoryId, repository]) =>
      Object.entries(repository.quantizations).map(
        ([quantization, variant]): DirectModelDownload => ({
          id: repositoryId,
          repositoryName: repository.name,
          label: `${repository.name} ${variant.label}`,
          description: variant.description,
          model: repository.model,
          scores: variant.scores,
          quantization,
          files: Object.entries(variant.files).map(([path, file]) => {
            const fileConfig = normalizeSuggestedModelFileConfig(file);
            const sourceRepository = fileConfig.sourceRepository ?? repositoryId;
            const sourcePath = fileConfig.sourcePath ?? path;

            return {
              path,
              url: buildHuggingFaceDownloadUrl(sourceRepository, sourcePath),
              type: resolveModelFileType(path),
              size: fileConfig.size,
            };
          }),
        }),
      ),
  );
}

export function getSuggestedModelDownloads(
  model: ManagedModel,
): DirectModelDownload[] {
  return SUGGESTED_MODEL_DOWNLOADS.filter(
    (download) => download.model === model,
  );
}

export function getKnownDownloadSize(download: DirectModelDownload): number {
  return download.files.reduce((total, file) => total + file.size, 0);
}

export function getModelVersionTitle(
  version: ModelVersionManifestEntry,
): string {
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

export function getDirectDownloadKey(download: DirectModelDownload): string {
  return `${download.model}-${download.id}-${download.label}`;
}

export function getDirectDownloadVersion(
  download: DirectModelDownload,
  versions: ModelVersionManifestEntry[],
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

export function getModelVersions(
  versions: ModelVersionManifestEntry[],
  model: ManagedModel,
): ModelVersionManifestEntry[] {
  return versions.filter((version) => version.model === model);
}

export async function downloadBlobWithProgress(
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

function normalizeSuggestedModelFileConfig(
  file: number | SuggestedModelFileConfig,
): SuggestedModelFileConfig {
  return typeof file === 'number' ? { size: file } : file;
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

function normalizeQuantization(quantization: string): string {
  return quantization
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-');
}

export function getQuantizedVersionName(
  modelName: string,
  quantization?: string,
): string {
  if (quantization === undefined || quantization.length === 0) {
    return modelName;
  }

  return `${modelName}--${normalizeQuantization(quantization)}`;
}
