import { env } from '@huggingface/transformers';
import { ModelManager } from '@notetaker/model-manager';
import { LOCAL_URL, ModelCache } from './model-cache';

let configured = false;

export function configureTransformersCache(modelManager: ModelManager): void {
  if (configured) {
    return;
  }

  env.useCustomCache = true;
  env.customCache = new ModelCache(modelManager, LOCAL_URL);
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.useBrowserCache = false;
  env.localModelPath = LOCAL_URL;
  configured = true;
}
