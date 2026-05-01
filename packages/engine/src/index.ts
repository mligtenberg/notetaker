import { env } from '@huggingface/transformers';
import { ModelCache, LOCAL_URL } from './lib/model-cache';
import { FileSystem } from '@notetaker/filesystem';
import { ModelManager } from '@notetaker/model-manager';

env.useCustomCache = true;
env.customCache = new ModelCache(
  await ModelManager.create(new FileSystem()),
  LOCAL_URL,
);
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;
// Prevent cache misses from falling through to Vite's /models/* HTML route.
env.localModelPath = LOCAL_URL;

export { LOCAL_URL };
export * from './lib/engine';
export * from './lib/engine-progress-event';
export * from './lib/engine-progress-status';
export * from './lib/engine-stage';
export * from './lib/process-meeting-options';
export * from './lib/pipeline-factory';
export * from './lib/speaker-diarization-engine';
export * from './lib/speaker-name-guess';
export * from './lib/speaker-naming-input';
export * from './lib/speaker-naming-model';
export * from './lib/transcription-engine';
export * from './lib/models/meeting';
export * from './lib/models/meeting-audio';
export * from './lib/models/meeting-notes';
export * from './lib/models/speaker-turn';
export * from './lib/models/transcript';
export * from './lib/models/transcript-segment';
export * from './lib/models/timestamped-text';
