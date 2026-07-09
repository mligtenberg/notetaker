import {
  ChatService,
  MemoryBudget,
  PipelineFactory,
  TransformersLanguageModel,
  estimateKvCacheBytes,
  estimateModelWeightsBytes,
  resolveContextTokens,
  resolveDefaultBudgetBytes,
  type ChatEvent,
  type TextGenerationPipelineLike,
  type Transcript,
} from '@notetaker/engine';
import {
  FileSystem,
  MeetingsRepository,
  type ChatThread,
} from '@notetaker/filesystem';
import type { ModelManager } from '@notetaker/model-manager';
import type {
  ChatWorkerRequest,
  ChatWorkerResponse,
} from './chat-worker-protocol';

/** Conservative KV token count for the pre-load admission check. */
const ADMISSION_CONTEXT_TOKENS = 3072;
/** Fraction of the free budget we let the KV cache use (rest is activations/buffers). */
const KV_CACHE_UTILIZATION = 0.6;
const MIN_CONTEXT_TOKENS = 2048;

let repoPromise: Promise<MeetingsRepository> | null = null;

function getRepository(): Promise<MeetingsRepository> {
  if (repoPromise === null) {
    repoPromise = new FileSystem()
      .getMeetingsDir()
      .then((dir) => new MeetingsRepository(dir));
  }
  return repoPromise;
}

interface DisposablePipeline extends TextGenerationPipelineLike {
  dispose?: () => Promise<void> | void;
}

// The language model runs on WASM (see PipelineFactory) — reliable, no GPU
// buffer limits, so context is bounded only by the memory budget. Its session
// is expensive to build, so cache it ONCE and reuse across turns and windows;
// recreating it per turn would leak a full model each time.
let cachedLanguage: {
  key: string;
  pipeline: DisposablePipeline;
  model: TransformersLanguageModel;
} | null = null;

// Serialize chat turns worker-wide: two turns must never run OrtRun on the
// shared session at the same time, which corrupts its buffers.
let chatQueue: Promise<void> = Promise.resolve();

function versionKey(manifest: { model: string; version: string; quantization?: string }): string {
  return `${manifest.model}/${manifest.version}/${manifest.quantization ?? ''}`;
}

async function disposeLanguageModel(): Promise<void> {
  const current = cachedLanguage;
  cachedLanguage = null;
  if (current?.pipeline.dispose) {
    try {
      await current.pipeline.dispose();
    } catch {
      // Best-effort release; ignore.
    }
  }
}

async function getLanguageModel(
  manifest: Parameters<PipelineFactory['getPipeline']>[0],
): Promise<TransformersLanguageModel> {
  const key = versionKey(manifest);
  if (cachedLanguage?.key === key) {
    return cachedLanguage.model;
  }

  // Active version changed (or first use): drop the old session, build one.
  await disposeLanguageModel();
  const pipeline = (await new PipelineFactory().getPipeline(
    manifest,
  )) as unknown as DisposablePipeline;
  cachedLanguage = { key, pipeline, model: new TransformersLanguageModel(pipeline) };
  return cachedLanguage.model;
}

function isSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /OrtRun|mapAsync|buffer|GPU|WebGPU|session|device is lost/i.test(message);
}

/**
 * Run one chat turn in the worker. Turns are serialized so they never share the
 * language session concurrently. Streams activity events and returns the final
 * assistant message.
 */
export function handleChatRequest(
  request: ChatWorkerRequest,
  modelManager: ModelManager,
  post: (message: ChatWorkerResponse) => void,
): Promise<void> {
  const run = chatQueue.then(() => runChatTurn(request, modelManager, post));
  chatQueue = run.catch(() => undefined);
  return run;
}

async function runChatTurn(
  request: ChatWorkerRequest,
  modelManager: ModelManager,
  post: (message: ChatWorkerResponse) => void,
): Promise<void> {
  const { id, chat } = request;

  try {
    const repository = await getRepository();

    const budget = new MemoryBudget(
      chat.budgetBytes ?? resolveDefaultBudgetBytes(),
    );
    if (chat.recordingActive) {
      for (const pipelineModel of ['transcription', 'diarization'] as const) {
        const active = await modelManager.getActiveVersion(pipelineModel);
        if (active !== null) {
          budget.register({
            key: pipelineModel,
            label: pipelineModel,
            bytes: estimateModelWeightsBytes(active.manifest.files),
            evictable: false,
          });
        }
      }
    }

    const language = await modelManager.getActiveVersion('language');
    if (language === null) {
      throw new Error(
        'Activate a language model (Settings → Models → Language) to use chat.',
      );
    }

    const weightsBytes = estimateModelWeightsBytes(language.manifest.files);
    const admission = budget.admitChat(
      weightsBytes +
        estimateKvCacheBytes({ contextTokens: ADMISSION_CONTEXT_TOKENS }),
    );
    if (!admission.ok) {
      throw new Error(admission.reason);
    }

    const model = await getLanguageModel(language.manifest);

    // Derive the prompt window from what memory can afford for the KV cache,
    // capped by the model's own context window. On WASM there is no GPU buffer
    // ceiling, so with a large RAM budget the model window is the limit.
    const cacheBudgetBytes =
      Math.max(0, budget.totalBytes - weightsBytes - budget.usedBytes()) *
      KV_CACHE_UTILIZATION;
    const contextTokens = resolveContextTokens({
      modelContextWindow: model.contextWindow,
      cacheBudgetBytes,
      minTokens: MIN_CONTEXT_TOKENS,
    });

    const service = new ChatService(model, { maxContextTokens: contextTokens });

    const transcript =
      chat.transcript ??
      (await repository.loadDerivation<Transcript>(
        chat.meetingId,
        'transcript',
      ));

    const thread: ChatThread = {
      id: chat.threadId,
      meetingId: chat.meetingId,
      title: '',
      createdAt: 0,
      updatedAt: 0,
      messageCount: chat.priorMessages.length,
      transcriptStatus: chat.transcriptStatus,
      messages: chat.priorMessages,
    };

    const message = await service.runTurn({
      thread,
      userText: chat.userText,
      transcript,
      transcriptStatus: chat.transcriptStatus,
      meetingTitle: chat.meetingTitle,
      artifacts: {
        list: async () =>
          (await repository.listArtifacts(chat.meetingId)).map((a) => a.name),
        read: async (name) =>
          (await repository.readArtifact(chat.meetingId, name))?.content ??
          null,
        write: async (name, content) =>
          (await repository.writeArtifact(chat.meetingId, name, content)).name,
      },
      onEvent: (event: ChatEvent) => post({ id, type: 'chat-event', event }),
      persistDelegateLog: async (log) => {
        await repository.saveDelegateLog(chat.meetingId, chat.threadId, log);
      },
      persistScanLog: async (log) => {
        await repository.saveScanLog(chat.meetingId, chat.threadId, log);
      },
    });

    post({ id, type: 'chat-result', ok: true, message, contextTokens });
  } catch (error) {
    // A session failure leaves the cached session unusable; drop it so the next
    // turn rebuilds a fresh one instead of reusing a broken one.
    if (isSessionError(error)) {
      await disposeLanguageModel();
    }

    post({
      id,
      type: 'chat-result',
      ok: false,
      error: error instanceof Error ? error.message : 'Chat failed.',
    });
  }
}
