import { useEffect, useState } from 'react';
import {
  estimateKvCacheBytes,
  estimateModelWeightsBytes,
  resolveDefaultBudgetBytes,
} from '@notetaker/engine';
import { FileSystem } from '@notetaker/filesystem';
import { ModelManager } from '@notetaker/model-manager';
import {
  summarizeMemory,
  type BudgetSegment,
  type MemorySnapshot,
} from '../chat/budget-format';

// Pre-turn KV estimate before the worker reports the real derived window.
const DEFAULT_CONTEXT_TOKENS = 3072;

/**
 * Compute the app-wide memory budget snapshot on the main thread from the active
 * model manifests — the same inputs and helpers the worker uses for admission,
 * so the display reflects the real budget. Pipeline models count only while
 * recording (they keep priority then). `contextTokens`, once reported by the
 * worker, sizes the KV-cache segment to the real prompt window.
 */
export function useMemoryBudget(
  recordingActive: boolean,
  refreshKey: number,
  contextTokens?: number | null,
): MemorySnapshot | null {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const modelManager = await ModelManager.create(new FileSystem());
        const segments: BudgetSegment[] = [];

        const language = await modelManager.getActiveVersion('language');
        if (language !== null) {
          segments.push({
            key: 'language',
            label: 'Language model',
            bytes: estimateModelWeightsBytes(language.manifest.files),
          });
          segments.push({
            key: 'kv',
            label: 'Chat context (KV cache)',
            bytes: estimateKvCacheBytes({
              contextTokens: contextTokens ?? DEFAULT_CONTEXT_TOKENS,
            }),
          });
        }

        if (recordingActive) {
          for (const model of ['transcription', 'diarization'] as const) {
            const version = await modelManager.getActiveVersion(model);
            if (version !== null) {
              segments.push({
                key: model,
                label: model === 'transcription' ? 'Transcription' : 'Diarization',
                bytes: estimateModelWeightsBytes(version.manifest.files),
              });
            }
          }
        }

        if (!cancelled) {
          setSnapshot(summarizeMemory(segments, resolveDefaultBudgetBytes()));
        }
      } catch {
        if (!cancelled) {
          setSnapshot(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [recordingActive, refreshKey, contextTokens]);

  return snapshot;
}
