import EngineWorker from './engine.worker.ts?worker';

/**
 * A single shared engine worker for the whole app. Chat and the processing
 * pipeline both post to it so the language model is loaded once, not once per
 * worker — the premise the memory budget depends on.
 */
let worker: Worker | null = null;

export function getSharedEngineWorker(): Worker {
  if (worker === null) {
    worker = new EngineWorker();
  }
  return worker;
}

export function disposeSharedEngineWorker(): void {
  worker?.terminate();
  worker = null;
}
