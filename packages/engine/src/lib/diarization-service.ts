import type { MeetingAudio } from './models/meeting-audio';
import type { SpeakerTurn } from './models/speaker-turn';
import { ModelManager } from '@notetaker/model-manager';
import {
  AutoModelForAudioFrameClassification,
  AutoProcessor,
} from '@huggingface/transformers';
import type { AudioDebugCallback } from './audio-utils';
import {
  withAudioInput,
  sanitizeAudioSamples,
} from './audio-utils';
import { requireActiveModel } from './model-utils';
import { read_audio } from "@huggingface/transformers";

const DIARIZATION_CHUNK_SECONDS = 60;
const DIARIZATION_MIN_CHUNK_SECONDS = 0.25;
const DIARIZATION_OVERLAP_SECONDS = 30;
const DIARIZATION_MIN_TURN_SECONDS = 0.5;
const DIARIZATION_SMOOTHING_GAP_SECONDS = 0.75;

type DiarizationOptions = {
  speakerCountHint?: number | null;
  debug?: AudioDebugCallback;
};

type DiarizationStitchingState = {
  speakerIndex: number;
  turns: SpeakerTurn[];
};

export class DiarizationService {
  constructor(private modelManager: ModelManager) {}

  async diarizeAudio(
    meetingAudio: MeetingAudio,
    options: DiarizationOptions = {},
  ): Promise<SpeakerTurn[]> {
    const speakerCountHint = normalizeSpeakerCountHint(
      options.speakerCountHint,
    );

    if (speakerCountHint !== null) {
      options.debug?.(
        `[diarization] constraining output to ${speakerCountHint} speaker(s).`,
      );
    }

    const activeModel = await requireActiveModel(
      this.modelManager,
      'diarization',
    );
    const modelId = `${activeModel.manifest.model}/${activeModel.manifest.version}`;
    const processor = (await AutoProcessor.from_pretrained(modelId)) as any;
    const model = (await AutoModelForAudioFrameClassification.from_pretrained(
      modelId,
      {
        device:
          typeof (globalThis as { navigator?: { gpu?: unknown } }).navigator
            ?.gpu !== 'undefined'
            ? 'webgpu'
            : 'wasm',
        dtype: activeModel.manifest.quantization as any,
      },
    )) as any;
    const sampleRate =
      processor.feature_extractor?.config.sampling_rate ?? 16_000;

    const audio = await loadAudioForDiarization(
      meetingAudio,
      sampleRate,
      options.debug,
    );

    if (audio.length === 0) {
      return [];
    }

    const chunkSize = Math.max(
      1,
      Math.floor(DIARIZATION_CHUNK_SECONDS * sampleRate),
    );
    const overlapSize = Math.min(
      chunkSize - 1,
      Math.floor(DIARIZATION_OVERLAP_SECONDS * sampleRate),
    );
    const stepSize = chunkSize - overlapSize;
    const stitchingState: DiarizationStitchingState = {
      speakerIndex: 0,
      turns: [],
    };

    options.debug?.(
      `[diarization] processing ${(audio.length / sampleRate).toFixed(2)}s audio in ${DIARIZATION_CHUNK_SECONDS}s chunk(s).`,
    );

    for (
      let startSample = 0;
      startSample < audio.length;
      startSample += stepSize
    ) {
      const endSample = Math.min(audio.length, startSample + chunkSize);
      const chunkTurns = await diarizeAudioChunkSafely(
        audio,
        startSample,
        endSample,
        audio.length,
        sampleRate,
        processor,
        model,
        speakerCountHint,
        options.debug,
      );

      appendDiarizationChunkTurns(
        stitchingState,
        chunkTurns,
        startSample,
        endSample,
        audio.length,
        sampleRate,
      );

      if (endSample === audio.length) {
        break;
      }
    }

    return smoothSpeakerTurns(mergeSpeakerTurns(stitchingState.turns));
  }
}

async function diarizeAudioChunkSafely(
  audio: Float32Array,
  startSample: number,
  endSample: number,
  totalSamples: number,
  sampleRate: number,
  processor: any,
  model: any,
  speakerCountHint: number | null,
  debug?: AudioDebugCallback,
): Promise<SpeakerTurn[]> {
  try {
    return await diarizeAudioChunk(
      audio.subarray(startSample, endSample),
      startSample,
      sampleRate,
      processor,
      model,
      speakerCountHint,
    );
  } catch (error) {
    const chunkSamples = endSample - startSample;
    const minChunkSamples = Math.max(
      1,
      Math.floor(DIARIZATION_MIN_CHUNK_SECONDS * sampleRate),
    );
    const message = getErrorMessage(error);

    if (chunkSamples <= minChunkSamples) {
      debug?.(
        `[diarization] skipping ${(chunkSamples / sampleRate).toFixed(2)}s chunk after ONNX Runtime failure: ${message}`,
      );
      return [];
    }

    const midpoint = startSample + Math.floor(chunkSamples / 2);
    debug?.(
      `[diarization] splitting ${(chunkSamples / sampleRate).toFixed(2)}s chunk after ONNX Runtime failure: ${message}`,
    );

    const firstHalf = await diarizeAudioChunkSafely(
      audio,
      startSample,
      midpoint,
      totalSamples,
      sampleRate,
      processor,
      model,
      speakerCountHint,
      debug,
    );
    const secondHalf = await diarizeAudioChunkSafely(
      audio,
      midpoint,
      endSample,
      totalSamples,
      sampleRate,
      processor,
      model,
      speakerCountHint,
      debug,
    );

    return [...firstHalf, ...secondHalf];
  }
}

async function diarizeAudioChunk(
  chunk: Float32Array,
  chunkStartSample: number,
  sampleRate: number,
  processor: any,
  model: any,
  speakerCountHint: number | null,
): Promise<SpeakerTurn[]> {
  const inputs = await processor(chunk);
  const { logits } = await model(inputs);
  const result =
    speakerCountHint === null
      ? (processor.post_process_speaker_diarization(
          logits,
          chunk.length,
        ) as any[])
      : postProcessSpeakerDiarizationWithSpeakerCount(
          logits,
          chunk.length,
          processor,
          speakerCountHint,
        );
  const chunkStartSeconds = chunkStartSample / sampleRate;

  const segments = (result[0] ?? []) as Array<{
    id: string | number;
    start: number;
    end: number;
  }>;

  return segments
    .map((segment): SpeakerTurn | null => {
      const startSeconds = chunkStartSeconds + segment.start;
      const endSeconds = chunkStartSeconds + segment.end;

      if (endSeconds <= startSeconds) {
        return null;
      }

      return {
        speaker: `SPEAKER_${String(segment.id).padStart(2, '0')}`,
        startSeconds,
        endSeconds,
        text: '',
      };
    })
    .filter((turn): turn is SpeakerTurn => turn !== null);
}

function appendDiarizationChunkTurns(
  state: DiarizationStitchingState,
  chunkTurns: SpeakerTurn[],
  startSample: number,
  endSample: number,
  totalSamples: number,
  sampleRate: number,
): void {
  const chunkStartSeconds = startSample / sampleRate;
  const chunkEndSeconds = endSample / sampleRate;
  const trimStartSeconds =
    startSample === 0
      ? chunkStartSeconds
      : chunkStartSeconds + DIARIZATION_OVERLAP_SECONDS / 2;
  const trimEndSeconds =
    endSample >= totalSamples
      ? chunkEndSeconds
      : chunkEndSeconds - DIARIZATION_OVERLAP_SECONDS / 2;
  const speakerMap = mapChunkSpeakersToGlobalSpeakers(
    chunkTurns,
    state.turns,
  );

  for (const turn of chunkTurns) {
    let speaker = speakerMap.get(turn.speaker);

    if (speaker === undefined) {
      speaker = `SPEAKER_${String(state.speakerIndex).padStart(2, '0')}`;
      state.speakerIndex += 1;
      speakerMap.set(turn.speaker, speaker);
    }

    const startSeconds = Math.max(trimStartSeconds, turn.startSeconds);
    const endSeconds = Math.min(trimEndSeconds, turn.endSeconds);

    if (endSeconds <= startSeconds) {
      continue;
    }

    state.turns.push({
      ...turn,
      speaker,
      startSeconds,
      endSeconds,
    });
  }
}

function mapChunkSpeakersToGlobalSpeakers(
  chunkTurns: SpeakerTurn[],
  previousTurns: SpeakerTurn[],
): Map<string, string> {
  const overlapBySpeakerPair = new Map<string, Map<string, number>>();
  const claimedSpeakers = new Set<string>();

  for (const chunkTurn of chunkTurns) {
    for (const previousTurn of previousTurns) {
      const overlapSeconds = Math.max(
        0,
        Math.min(chunkTurn.endSeconds, previousTurn.endSeconds) -
          Math.max(chunkTurn.startSeconds, previousTurn.startSeconds),
      );

      if (overlapSeconds <= 0) {
        continue;
      }

      const overlapsForChunkSpeaker =
        overlapBySpeakerPair.get(chunkTurn.speaker) ??
        new Map<string, number>();

      overlapsForChunkSpeaker.set(
        previousTurn.speaker,
        (overlapsForChunkSpeaker.get(previousTurn.speaker) ?? 0) +
          overlapSeconds,
      );
      overlapBySpeakerPair.set(chunkTurn.speaker, overlapsForChunkSpeaker);
    }
  }

  const sortedMatches = [...overlapBySpeakerPair.entries()]
    .flatMap(([chunkSpeaker, overlaps]) =>
      [...overlaps.entries()].map(([speaker, overlapSeconds]) => ({
        chunkSpeaker,
        speaker,
        overlapSeconds,
      })),
    )
    .sort((first, second) => second.overlapSeconds - first.overlapSeconds);
  const speakerMap = new Map<string, string>();

  for (const match of sortedMatches) {
    if (
      speakerMap.has(match.chunkSpeaker) ||
      claimedSpeakers.has(match.speaker)
    ) {
      continue;
    }

    speakerMap.set(match.chunkSpeaker, match.speaker);
    claimedSpeakers.add(match.speaker);
  }

  return speakerMap;
}

function mergeSpeakerTurns(turns: SpeakerTurn[]): SpeakerTurn[] {
  const sortedTurns = [...turns].sort(
    (first, second) => first.startSeconds - second.startSeconds,
  );
  const mergedTurns: SpeakerTurn[] = [];

  for (const turn of sortedTurns) {
    const previousTurn = mergedTurns.at(-1);

    if (previousTurn !== undefined && previousTurn.speaker === turn.speaker) {
      previousTurn.endSeconds = Math.max(
        previousTurn.endSeconds,
        turn.endSeconds,
      );
      continue;
    }

    mergedTurns.push({ ...turn });
  }

  return mergedTurns;
}

function smoothSpeakerTurns(turns: SpeakerTurn[]): SpeakerTurn[] {
  const sortedTurns = [...turns].sort(
    (first, second) => first.startSeconds - second.startSeconds,
  );
  const smoothedTurns: SpeakerTurn[] = [];

  for (let index = 0; index < sortedTurns.length; index += 1) {
    const turn = sortedTurns[index];
    const previousTurn = smoothedTurns.at(-1);
    const nextTurn = sortedTurns[index + 1];
    const durationSeconds = turn.endSeconds - turn.startSeconds;

    if (
      durationSeconds < DIARIZATION_MIN_TURN_SECONDS &&
      previousTurn !== undefined &&
      nextTurn !== undefined &&
      previousTurn.speaker === nextTurn.speaker &&
      turn.startSeconds - previousTurn.endSeconds <=
        DIARIZATION_SMOOTHING_GAP_SECONDS &&
      nextTurn.startSeconds - turn.endSeconds <=
        DIARIZATION_SMOOTHING_GAP_SECONDS
    ) {
      previousTurn.endSeconds = Math.max(
        previousTurn.endSeconds,
        nextTurn.endSeconds,
      );
      index += 1;
      continue;
    }

    if (
      durationSeconds < DIARIZATION_MIN_TURN_SECONDS &&
      previousTurn !== undefined &&
      turn.startSeconds - previousTurn.endSeconds <=
        DIARIZATION_SMOOTHING_GAP_SECONDS &&
      (nextTurn === undefined || nextTurn.speaker !== turn.speaker)
    ) {
      previousTurn.endSeconds = Math.max(
        previousTurn.endSeconds,
        turn.endSeconds,
      );
      continue;
    }

    smoothedTurns.push({ ...turn });
  }

  return mergeSpeakerTurns(smoothedTurns);
}

function normalizeSpeakerCountHint(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(1, Math.floor(value));
}

function postProcessSpeakerDiarizationWithSpeakerCount(
  logits: { tolist(): number[][][] },
  numSamples: number,
  processor: any,
  speakerCount: number,
): any[] {
  const featureExtractor = processor.feature_extractor ?? processor;
  const config = featureExtractor.config ?? {};
  const samplingRate = config.sampling_rate ?? 16_000;
  const frameCount =
    typeof featureExtractor.samples_to_frames === 'function'
      ? featureExtractor.samples_to_frames(numSamples)
      : numSamples;
  const ratio = numSamples / frameCount / samplingRate;

  return logits.tolist().map((scores) => {
    const segments: Array<{
      id: number;
      start: number;
      end: number;
      score: number;
    }> = [];
    let currentSpeaker = -1;

    for (let index = 0; index < scores.length; index += 1) {
      const frameScores = scores[index];
      const limitedCount = Math.min(speakerCount, frameScores.length);
      let id = 0;
      let score = frameScores[0] ?? 0;

      for (
        let speakerIndex = 1;
        speakerIndex < limitedCount;
        speakerIndex += 1
      ) {
        const speakerScore =
          frameScores[speakerIndex] ?? Number.NEGATIVE_INFINITY;

        if (speakerScore > score) {
          id = speakerIndex;
          score = speakerScore;
        }
      }

      if (id !== currentSpeaker) {
        currentSpeaker = id;
        segments.push({ id, start: index, end: index + 1, score });
      } else {
        const segment = segments.at(-1);

        if (segment !== undefined) {
          segment.end = index + 1;
          segment.score += score;
        }
      }
    }

    return segments.map(({ id, start, end, score }) => ({
      id,
      start: start * ratio,
      end: end * ratio,
      confidence: score / (end - start),
    }));
  });
}

async function loadAudioForDiarization(
  meetingAudio: MeetingAudio,
  sampleRate: number,
  debug?: AudioDebugCallback,
): Promise<Float32Array> {
  const rawAudio = await withAudioInput(
    meetingAudio,
    (audioInput) =>
      audioInput instanceof Float32Array
        ? Promise.resolve(audioInput)
        : (async () => {
            return read_audio(audioInput, sampleRate);
          })(),
    debug,
  );

  return sanitizeAudioSamples(rawAudio);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
