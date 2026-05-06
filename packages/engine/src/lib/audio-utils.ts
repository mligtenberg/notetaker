import type { MeetingAudio } from './models/meeting-audio';
import { read_audio } from '@huggingface/transformers';

export type AudioInput = string | URL | Float32Array;

export type AudioDebugCallback = (line: string) => void;

export async function toAudioInput(
  meetingAudio: MeetingAudio,
): Promise<AudioInput> {
  if (meetingAudio instanceof Float32Array) {
    return meetingAudio;
  }

  if (typeof URL.createObjectURL === 'function') {
    if (meetingAudio instanceof Blob) {
      return URL.createObjectURL(meetingAudio);
    }

    if (meetingAudio instanceof ArrayBuffer) {
      return URL.createObjectURL(new Blob([meetingAudio]));
    }

    if (meetingAudio instanceof Uint8Array) {
      return URL.createObjectURL(new Blob([new Uint8Array(meetingAudio)]));
    }
  }

  return toFloat32Samples(meetingAudio);
}

export async function withAudioInput<T>(
  meetingAudio: MeetingAudio,
  callback: (audioInput: AudioInput) => Promise<T>,
  debug?: AudioDebugCallback,
): Promise<T> {
  debug?.('[audio] converting MeetingAudio to AudioInput...');
  const audioInput = await toAudioInput(meetingAudio);
  debug?.(`[audio] converted to ${describeAudioInput(audioInput)}.`);

  try {
    return await callback(audioInput);
  } finally {
    if (typeof audioInput === 'string' && audioInput.startsWith('blob:')) {
      debug?.('[audio] revoking temporary blob URL.');
      URL.revokeObjectURL(audioInput);
    }
  }
}

export function describeMeetingAudio(meetingAudio: MeetingAudio): string {
  if (meetingAudio instanceof Float32Array) {
    return `Float32Array(${meetingAudio.length} samples)`;
  }

  if (meetingAudio instanceof Uint8Array) {
    return `Uint8Array(${meetingAudio.byteLength} bytes)`;
  }

  if (meetingAudio instanceof ArrayBuffer) {
    return `ArrayBuffer(${meetingAudio.byteLength} bytes)`;
  }

  if (meetingAudio instanceof Blob) {
    return `Blob(${meetingAudio.size} bytes, ${meetingAudio.type || 'unknown type'})`;
  }

  return 'unknown audio input';
}

export function describeAudioInput(audioInput: AudioInput): string {
  if (audioInput instanceof Float32Array) {
    return `Float32Array(${audioInput.length} samples)`;
  }

  if (audioInput instanceof Float64Array) {
    return `Float64Array(${audioInput.length} samples)`;
  }

  if (audioInput instanceof URL) {
    return `URL(${audioInput.href})`;
  }

  return audioInput.startsWith('blob:')
    ? 'blob URL'
    : `string(${audioInput})`;
}

export function sanitizeAudioSamples(audio: Float32Array): Float32Array {
  let needsCopy = false;

  for (let index = 0; index < audio.length; index += 1) {
    const sample = audio[index];

    if (!Number.isFinite(sample) || sample < -1 || sample > 1) {
      needsCopy = true;
      break;
    }
  }

  if (!needsCopy) {
    return audio;
  }

  const sanitized = new Float32Array(audio.length);

  for (let index = 0; index < audio.length; index += 1) {
    const sample = audio[index];

    sanitized[index] = Number.isFinite(sample)
      ? Math.max(-1, Math.min(1, sample))
      : 0;
  }

  return sanitized;
}

export function resampleAudioIfNeeded(
  audio: Float32Array,
  sourceSampleRate: number | undefined,
  targetSampleRate: number,
): Float32Array {
  if (
    sourceSampleRate === undefined ||
    !Number.isFinite(sourceSampleRate) ||
    sourceSampleRate <= 0 ||
    Math.round(sourceSampleRate) === Math.round(targetSampleRate)
  ) {
    return audio;
  }

  const targetLength = Math.max(
    1,
    Math.round((audio.length * targetSampleRate) / sourceSampleRate),
  );
  const resampled = new Float32Array(targetLength);
  const ratio = sourceSampleRate / targetSampleRate;

  for (let index = 0; index < targetLength; index += 1) {
    const sourceIndex = index * ratio;
    const lowerIndex = Math.floor(sourceIndex);
    const upperIndex = Math.min(audio.length - 1, lowerIndex + 1);
    const weight = sourceIndex - lowerIndex;
    const lowerSample = audio[lowerIndex] ?? 0;
    const upperSample = audio[upperIndex] ?? lowerSample;

    resampled[index] = lowerSample + (upperSample - lowerSample) * weight;
  }

  return resampled;
}

export async function toFloat32Samples(
  meetingAudio: MeetingAudio,
): Promise<Float32Array> {
  if (meetingAudio instanceof Float32Array) {
    return meetingAudio;
  }

  if (meetingAudio instanceof ArrayBuffer) {
    return bufferToFloat32Array(meetingAudio);
  }

  if (meetingAudio instanceof Uint8Array) {
    return bufferToFloat32Array(
      meetingAudio.buffer.slice(
        meetingAudio.byteOffset,
        meetingAudio.byteOffset + meetingAudio.byteLength,
      ),
    );
  }

  if (meetingAudio instanceof Blob) {
    return bufferToFloat32Array(await meetingAudio.arrayBuffer());
  }

  return new Float32Array(0);
}

export function bufferToFloat32Array(
  buffer: ArrayBufferLike,
): Float32Array {
  if (buffer.byteLength === 0) {
    return new Float32Array(0);
  }

  if (buffer.byteLength % Float32Array.BYTES_PER_ELEMENT === 0) {
    return new Float32Array(buffer);
  }

  const bytes = new Uint8Array(buffer);
  const samples = new Float32Array(bytes.length);

  for (let index = 0; index < bytes.length; index += 1) {
    samples[index] = (bytes[index] - 128) / 128;
  }

  return samples;
}

export async function loadAudioAsFloat32(
  meetingAudio: MeetingAudio,
  sampleRate: number,
  debug?: AudioDebugCallback,
): Promise<Float32Array> {
  const readAudio = read_audio as unknown as (
    input: unknown,
    sampleRate: number,
  ) => Promise<Float32Array>;

  return withAudioInput(
    meetingAudio,
    (audioInput) =>
      audioInput instanceof Float32Array
        ? Promise.resolve(audioInput)
        : readAudio(audioInput, sampleRate),
    debug,
  );
}
