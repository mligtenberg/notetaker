import {ManagedModel, ModelManager} from '@notetaker/model-manager';
import {PipelineFactory} from "./pipeline-factory";

export function getErrorMessage(error: unknown): string {
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

export function isModelSessionError(error: unknown): boolean {
  const message = getErrorMessage(error);

  return (
    message.includes("Can't create a session") ||
    message.includes('Failed to load external data file') ||
    message.includes('Deserialize tensor')
  );
}

export function describeTranscriptionResult(result: unknown): string {
  if (typeof result === 'string') {
    return `string(length=${result.length})`;
  }

  if (typeof result === 'object' && result !== null) {
    const record = result as Record<string, unknown>;
    return `object(textLength=${(record.text as string | undefined)?.length ?? 0}, chunks=${(record.chunks as unknown[] | undefined)?.length ?? 0})`;
  }

  return 'unknown';
}

export type CallablePipeline = (input: unknown, options?: unknown) => Promise<unknown>;

export async function getPipelineForActiveModel(
  pipelineFactory: PipelineFactory,
  modelManager: ModelManager,
  model: ManagedModel,
  additionalOptions?: Record<string, unknown>,
): Promise<CallablePipeline> {
  const activeModel = await requireActiveModel(modelManager, model);

  return (await pipelineFactory.getPipeline(
    activeModel.manifest,
    additionalOptions,
  )) as CallablePipeline;
}

export async function requireActiveModel(
  modelManager: ModelManager,
  model: ManagedModel,
) {
  const activeModel = await modelManager.getActiveVersion(model);

  if (activeModel === null) {
    throw new Error(`Download and activate a ${model} model first.`);
  }

  return activeModel;
}

export async function requireActiveModelForLanguage(
  modelManager: ModelManager,
  model: ManagedModel,
  languageCode: string | undefined,
) {
  if (languageCode !== undefined) {
    const languageActive = await modelManager.getActiveVersionForLanguage(
      model,
      languageCode,
    );

    if (languageActive !== null) {
      return languageActive;
    }
  }

  return requireActiveModel(modelManager, model);
}
