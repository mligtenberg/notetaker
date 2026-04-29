import {
  AutoModelForAudioFrameClassification,
  AutoProcessor,
  Tensor,
  env,
} from '@huggingface/transformers';
import {
  type ManagedModel,
  type ModelManager,
  type ModelVersionManifestEntry,
} from '@notetaker/model-manager';
import { requireModelVersion } from './active-model-transcription-engine';
import type { Meeting } from './models/meeting';
import type { SpeakerTurn } from './models/speaker-turn';
import type { SpeakerDiarizationEngine } from './speaker-diarization-engine';

type ModelSelections = Partial<Record<ManagedModel, string>>;

interface PipelineProgressEvent {
  status?: string;
  name?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

interface PyAnnoteProcessor {
  (audio: Float32Array): Promise<{ input_values: Tensor }>;
  post_process_speaker_diarization(
    logits: Tensor,
    numSamples: number,
  ): DiarizationSegment[][];
  sampling_rate: number;
  feature_extractor: {
    config: {
      sampling_rate: number;
    };
  };
}

interface DiarizationSegment {
  id: number;
  start: number;
  end: number;
  confidence: number;
}

interface TransformersCache {
  match(request: string | Request): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

export interface ActiveModelSpeakerDiarizationEngineOptions {
  modelManager: ModelManager;
  selectedModels?: ModelSelections;
  numSpeakers?: number | null;
  onLog?: (line: string) => void;
  onProgress?: (value: number | null) => void;
}

// Module-level cache: avoids reloading on every call.
let cachedModel: Awaited<
  ReturnType<typeof AutoModelForAudioFrameClassification.from_pretrained>
> | null = null;
let cachedProcessor: PyAnnoteProcessor | null = null;
let cachedModelId = '';
let cachedModelVersion = '';

// 10 s window at 16 kHz — the fixed input size expected by pyannote-segmentation-3.0.
const CHUNK_SAMPLES = 160_000;
const MIN_SEGMENT_DURATION_S = 0.5;
// Filter out low-confidence segments — reduces false speaker splits from uncertain frames.
const MIN_CONFIDENCE = 0.5;
// Merge consecutive turns from the same speaker separated by a short gap.
const MERGE_GAP_S = 0.5;
// Assign the same global speaker if a segment starts within this many seconds of the
// last time that global speaker was heard.
const SPEAKER_GAP_THRESHOLD_S = 2.0;
// Island removal: a short turn flanked by the same speaker on both sides is reassigned.
const ISLAND_MAX_DURATION_S = 2.0;

export class ActiveModelSpeakerDiarizationEngine implements SpeakerDiarizationEngine {
  readonly #modelManager: ModelManager;
  readonly #selectedModels: ModelSelections;
  readonly #numSpeakers: number | null;
  readonly #onLog: (line: string) => void;
  readonly #onProgress: (value: number | null) => void;

  constructor(options: ActiveModelSpeakerDiarizationEngineOptions) {
    this.#modelManager = options.modelManager;
    this.#selectedModels = options.selectedModels ?? {};
    this.#numSpeakers = options.numSpeakers ?? null;
    this.#onLog = options.onLog ?? (() => undefined);
    this.#onProgress = options.onProgress ?? (() => undefined);
  }

  async diarize(meeting: Meeting): Promise<SpeakerTurn[]> {
    const manifest = await requireModelVersion(
      this.#modelManager,
      'pyannote',
      this.#selectedModels.pyannote,
    );

    this.#assertSegmentationModel(manifest);
    const modelId = this.#resolveModelId(manifest);
    const { model, processor } = await this.#getModel(modelId, manifest);
    const audio = this.#normalizeAudio(meeting.audio);
    const turns = await this.#runDiarization(model, processor, audio, this.#numSpeakers);

    this.#onProgress(null);

    return turns;
  }

  async #runDiarization(
    model: NonNullable<typeof cachedModel>,
    processor: PyAnnoteProcessor,
    audio: Float32Array,
    numSpeakers: number | null,
  ): Promise<SpeakerTurn[]> {
    const samplingRate =
      processor.feature_extractor.config.sampling_rate ?? 16_000;
    const numChunks = Math.ceil(audio.length / CHUNK_SAMPLES);

    // global_speaker_id -> last seen end time (seconds)
    const speakerLastSeen = new Map<number, number>();
    let nextGlobalId = 0;

    // Persistent cross-chunk mapping: pyannote class ID -> global speaker ID.
    // pyannote tends to assign the same class index to the same physical speaker
    // across chunks of the same recording, so we can reuse this mapping to maintain
    // consistent identities without relying on temporal proximity alone.
    const classToGlobal = new Map<number, number>();

    const allTurns: SpeakerTurn[] = [];

    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
      const chunkStart = chunkIdx * CHUNK_SAMPLES;
      const chunkOffsetS = chunkStart / samplingRate;
      const rawChunk = audio.subarray(chunkStart, chunkStart + CHUNK_SAMPLES);

      // Pad the last chunk with silence if shorter than CHUNK_SAMPLES.
      const paddedChunk = new Float32Array(CHUNK_SAMPLES);
      paddedChunk.set(rawChunk);

      const inputs = await processor(paddedChunk);
      const output = (await model(inputs)) as { logits: Tensor };

      // Use rawChunk.length so time coordinates don't extend into the padded region.
      const localSegments = processor.post_process_speaker_diarization(
        output.logits,
        rawChunk.length,
      )[0];

      // Sort by start time; build a stable local→global mapping for this chunk.
      localSegments.sort((a, b) => a.start - b.start);
      const localToGlobal = new Map<number, number>();

      for (const seg of localSegments) {
        if (seg.end - seg.start < MIN_SEGMENT_DURATION_S) {
          continue;
        }

        if (seg.confidence < MIN_CONFIDENCE) {
          continue;
        }

        const globalStart = chunkOffsetS + seg.start;
        const globalEnd = chunkOffsetS + seg.end;

        let globalId: number;

        if (localToGlobal.has(seg.id)) {
          // Already resolved within this chunk — reuse.
          globalId = localToGlobal.get(seg.id)!;
        } else if (numSpeakers === 1) {
          // Caller guarantees single speaker — skip all matching logic.
          globalId = 0;
          nextGlobalId = Math.max(nextGlobalId, 1);
          localToGlobal.set(seg.id, globalId);
        } else {
          const claimedGlobal = new Set(localToGlobal.values());
          const historicalGlobal = classToGlobal.get(seg.id);

          if (historicalGlobal !== undefined && !claimedGlobal.has(historicalGlobal)) {
            // The model used this class ID before and it isn't claimed yet this chunk —
            // trust the historical assignment for cross-chunk speaker continuity.
            globalId = historicalGlobal;
          } else {
            // No usable history: fall back to temporal proximity.
            let bestId = -1;
            let bestGap = SPEAKER_GAP_THRESHOLD_S;

            for (const [gId, lastEnd] of speakerLastSeen) {
              if (claimedGlobal.has(gId)) {
                continue;
              }

              const gap = globalStart - lastEnd;

              if (gap >= 0 && gap < bestGap) {
                bestId = gId;
                bestGap = gap;
              }
            }

            globalId = bestId !== -1 ? bestId : nextGlobalId++;
          }

          localToGlobal.set(seg.id, globalId);
          classToGlobal.set(seg.id, globalId);
        }

        speakerLastSeen.set(globalId, globalEnd);
        allTurns.push({
          speaker: `speaker-${globalId}`,
          startSeconds: globalStart,
          endSeconds: globalEnd,
        });
      }

      this.#onProgress(((chunkIdx + 1) / numChunks) * 100);
    }

    return this.#removeIslands(this.#mergeTurns(allTurns));
  }

  #mergeTurns(turns: SpeakerTurn[]): SpeakerTurn[] {
    if (turns.length === 0) {
      return turns;
    }

    const sorted = [...turns].sort((a, b) => a.startSeconds - b.startSeconds);
    const merged: SpeakerTurn[] = [{ ...sorted[0] }];

    for (let i = 1; i < sorted.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = sorted[i];

      if (
        curr.speaker === prev.speaker &&
        curr.startSeconds - prev.endSeconds <= MERGE_GAP_S
      ) {
        prev.endSeconds = Math.max(prev.endSeconds, curr.endSeconds);
      } else {
        merged.push({ ...curr });
      }
    }

    return merged;
  }

  // If a speaker turn is short and flanked on both sides by the same speaker,
  // it is almost certainly a misclassification — absorb it into the surrounding turns.
  #removeIslands(turns: SpeakerTurn[]): SpeakerTurn[] {
    if (turns.length < 3) {
      return turns;
    }

    let result = [...turns];
    let changed = true;

    while (changed) {
      changed = false;

      for (let i = 1; i < result.length - 1; i++) {
        const prev = result[i - 1];
        const curr = result[i];
        const next = result[i + 1];

        if (
          prev.speaker === next.speaker &&
          curr.speaker !== prev.speaker &&
          curr.endSeconds - curr.startSeconds <= ISLAND_MAX_DURATION_S
        ) {
          const merged: SpeakerTurn = {
            ...prev,
            endSeconds: Math.max(prev.endSeconds, next.endSeconds),
          };
          result.splice(i - 1, 3, merged);
          changed = true;
          break;
        }
      }
    }

    return result;
  }

  async #getModel(
    modelId: string,
    manifest: ModelVersionManifestEntry,
  ): Promise<{ model: NonNullable<typeof cachedModel>; processor: PyAnnoteProcessor }> {
    if (
      cachedModel !== null &&
      cachedProcessor !== null &&
      cachedModelId === modelId &&
      cachedModelVersion === manifest.version
    ) {
      return { model: cachedModel, processor: cachedProcessor };
    }

    cachedModel?.dispose?.();
    cachedModelId = modelId;
    cachedModelVersion = manifest.version;

    this.#onLog(`[diarization] loading ${modelId}`);
    this.#configureModelCache(modelId, manifest);

    const [model, processor] = await Promise.all([
      AutoModelForAudioFrameClassification.from_pretrained(modelId, {
        local_files_only: true,
        dtype: this.#resolveDtype(manifest),
        progress_callback: (event: PipelineProgressEvent) =>
          this.#handleProgress(event),
      } as Record<string, unknown>),
      AutoProcessor.from_pretrained(modelId, {
        local_files_only: true,
      } as Record<string, unknown>),
    ]);

    cachedModel = model;
    cachedProcessor = processor as unknown as PyAnnoteProcessor;

    return { model, processor: cachedProcessor };
  }

  #configureModelCache(model: string, manifest: ModelVersionManifestEntry): void {
    const fileEntries = new Map(
      manifest.files.map((file) => [file.path, file] as const),
    );
    const cache: TransformersCache = {
      match: async (request) => {
        const requestUrl = typeof request === 'string' ? request : request.url;
        const file = this.#getRequestedModelFile(requestUrl, model, fileEntries);

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
          `[diarization] local model file: ${file.path} (${body.byteLength} bytes)`,
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

  #resolveModelId(manifest: ModelVersionManifestEntry): string {
    const huggingFaceModelId = manifest.metadata?.['huggingFaceModelId'];

    if (
      typeof huggingFaceModelId === 'string' &&
      huggingFaceModelId.length > 0
    ) {
      return huggingFaceModelId;
    }

    throw new Error(
      `Pyannote model ${manifest.version} is missing a Hugging Face model id.`,
    );
  }

  // Maps the ONNX file present in the manifest to the dtype string that
  // transformers.js uses to construct the filename (suffix mapping in dtypes.js).
  #resolveDtype(manifest: ModelVersionManifestEntry): string {
    const files = new Set(manifest.files.map((f) => f.path));

    if (files.has('onnx/model_quantized.onnx')) return 'q8';
    if (files.has('onnx/model_int8.onnx')) return 'int8';
    if (files.has('onnx/model_fp16.onnx')) return 'fp16';
    return 'fp32';
  }

  // The segmentation model ships config.json + preprocessor_config.json and is
  // loadable via AutoModelForAudioFrameClassification. The embedding model is a
  // bare ONNX file with no processor and cannot perform standalone diarization.
  #assertSegmentationModel(manifest: ModelVersionManifestEntry): void {
    const hasConfig = manifest.files.some((f) => f.path === 'config.json');

    if (!hasConfig) {
      const modelId = manifest.metadata?.['huggingFaceModelId'] ?? manifest.version;
      throw new Error(
        `"${modelId}" is a speaker embedding model and cannot run standalone diarization. ` +
          'Download and activate the pyannote-segmentation-3.0 model instead.',
      );
    }
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
      this.#onLog(`[diarization] ${event.status}: ${target}`);
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

    throw new Error('Diarization requires decoded Float32Array audio samples.');
  }
}
