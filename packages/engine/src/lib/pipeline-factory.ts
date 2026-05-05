import { ModelVersionManifestEntry } from '@notetaker/model-manager';
import { pipeline, PipelineType } from '@huggingface/transformers';

export class PipelineFactory {
  constructor() {}

  getPipeline(
    manifest: ModelVersionManifestEntry,
    additionalOptions?: Omit<Parameters<typeof pipeline>[2], 'dtype' | 'device'>,
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
        device: this.#getDevice(manifest),
        local_files_only: true,
      },
    );
  }

  #getDevice(manifest: ModelVersionManifestEntry) {
    if (manifest.model === 'transcription') {
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
