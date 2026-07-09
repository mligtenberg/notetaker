import { ModelVersionManifestEntry } from '@notetaker/model-manager';
import { pipeline, PipelineType } from '@huggingface/transformers';

export type PipelineDevice = 'auto' | 'webgpu' | 'wasm' | 'cpu';

export class PipelineFactory {
  constructor() {}

  getPipeline(
    manifest: ModelVersionManifestEntry,
    additionalOptions?: Omit<Parameters<typeof pipeline>[2], 'dtype' | 'device'>,
    deviceOverride?: PipelineDevice,
  ) {
    return pipeline(
      this.#getPipelineType(manifest),
      `${manifest.model}/${manifest.version}`,
      {
        ...(additionalOptions ?? {}),
        dtype: manifest.quantization as Extract<
          Parameters<typeof pipeline>[2],
          { dtype?: unknown }
        >['dtype'],
        device: deviceOverride ?? this.#getDevice(manifest),
        local_files_only: true,
      },
    );
  }

  #getDevice(manifest: ModelVersionManifestEntry) {
    // Transcription and the language model run on WASM: WebGPU is unstable for
    // them in-browser (transcription's Whisper encoder; the language model's
    // large multi-step chat prompts exceed GPU buffer limits). WASM is slower
    // but has no such limits, so context is bounded only by the memory budget.
    if (manifest.model === 'transcription' || manifest.model === 'language') {
      return 'wasm';
    }

    return 'auto';
  }

  #getPipelineType(manifest: ModelVersionManifestEntry): PipelineType {
    if (manifest.model === 'transcription') {
      return 'automatic-speech-recognition';
    }

    if (manifest.model === 'language') {
      return 'text-generation';
    }

    // Known: Diarization and Alignment is not supported
    throw new Error('Not supported in pipelines');
  }
}
