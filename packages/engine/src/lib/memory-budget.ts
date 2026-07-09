import type { ModelFileManifestEntry } from '@notetaker/model-manager';

/**
 * The app-wide byte budget on everything resident at once: model weights,
 * inference caches and buffers. Derived from the device, user-adjustable. Token
 * caps and similar guards are subordinate tools that protect it. When it can't
 * stretch, recording always wins — pipeline allocations are never evicted for
 * chat.
 */

/** Conservative fraction of reported device memory to spend by default. */
export const DEFAULT_BUDGET_FRACTION = 0.5;
/** navigator.deviceMemory is coarse and capped (often 8 max); assume this when absent. */
const FALLBACK_DEVICE_MEMORY_GB = 4;
const BYTES_PER_GB = 1024 * 1024 * 1024;

/** A single resident consumer of the budget. */
export interface MemoryAllocation {
  key: string;
  label: string;
  bytes: number;
  /**
   * Whether chat may reclaim this to make room for itself. Pipeline (recording)
   * allocations are never evictable — recording always wins.
   */
  evictable: boolean;
}

export interface KvCacheEstimateOptions {
  contextTokens: number;
  numLayers?: number;
  numKeyValueHeads?: number;
  headDim?: number;
  /** 2 for fp16/bf16, 1 for int8. */
  bytesPerElement?: number;
}

// Conservative defaults for a small (2–4B) on-device Gemma-class model. The KV
// cache is a minor term next to weights, so over-estimating here is cheap.
const DEFAULT_KV_LAYERS = 34;
const DEFAULT_KV_HEADS = 8;
const DEFAULT_KV_HEAD_DIM = 256;
const DEFAULT_KV_BYTES_PER_ELEMENT = 2;

/** Resolve the default budget from device signals. */
export function resolveDefaultBudgetBytes(
  deviceMemoryGb: number | undefined = readDeviceMemoryGb(),
  fraction: number = DEFAULT_BUDGET_FRACTION,
): number {
  const gb = deviceMemoryGb ?? FALLBACK_DEVICE_MEMORY_GB;
  return Math.round(gb * fraction * BYTES_PER_GB);
}

function readDeviceMemoryGb(): number | undefined {
  if (typeof navigator === 'undefined') {
    return undefined;
  }

  const value = (navigator as Navigator & { deviceMemory?: number })
    .deviceMemory;
  return typeof value === 'number' && value > 0 ? value : undefined;
}

/** Sum of on-disk weight file sizes, a good proxy for resident weight bytes. */
export function estimateModelWeightsBytes(
  files: ReadonlyArray<Pick<ModelFileManifestEntry, 'size'>>,
): number {
  return files.reduce((total, file) => total + (file.size ?? 0), 0);
}

export interface ContextTokenOptions {
  /** The model's own maximum context length (from its config), if known. */
  modelContextWindow?: number;
  /** Bytes the memory budget can spend on the KV cache. */
  cacheBudgetBytes: number;
  /** Optional ceiling (e.g. a GPU-safe cap on the WebGPU backend). */
  hardCap?: number;
  /** Never return fewer than this many tokens. */
  minTokens?: number;
  kv?: Omit<KvCacheEstimateOptions, 'contextTokens'>;
}

/**
 * How many prompt tokens the chat may hold: the smallest of what the memory
 * budget affords for the KV cache, the model's own context window, and any hard
 * cap. This is the "token cap protects the Memory Budget" rule made concrete —
 * with lots of RAM the model window is the limit; with little, memory is.
 */
export function resolveContextTokens(options: ContextTokenOptions): number {
  const perToken = estimateKvCacheBytes({ ...options.kv, contextTokens: 1 });
  const affordable =
    perToken > 0
      ? Math.floor(Math.max(0, options.cacheBudgetBytes) / perToken)
      : 0;

  const caps = [affordable];
  if (options.modelContextWindow && options.modelContextWindow > 0) {
    caps.push(options.modelContextWindow);
  }
  if (options.hardCap && options.hardCap > 0) {
    caps.push(options.hardCap);
  }

  return Math.max(options.minTokens ?? 1024, Math.min(...caps));
}

/** Rough KV-cache footprint for a given context length. */
export function estimateKvCacheBytes(options: KvCacheEstimateOptions): number {
  const layers = options.numLayers ?? DEFAULT_KV_LAYERS;
  const kvHeads = options.numKeyValueHeads ?? DEFAULT_KV_HEADS;
  const headDim = options.headDim ?? DEFAULT_KV_HEAD_DIM;
  const bytesPerElement =
    options.bytesPerElement ?? DEFAULT_KV_BYTES_PER_ELEMENT;

  // 2 tensors (key + value) per layer.
  return (
    2 * layers * options.contextTokens * kvHeads * headDim * bytesPerElement
  );
}

/** Outcome of asking whether chat can run within the budget right now. */
export type ChatAdmission =
  | { ok: true; projectedBytes: number; freeBytes: number }
  | {
      ok: false;
      reason: string;
      requiredBytes: number;
      freeBytes: number;
    };

/**
 * Live view of what is resident and whether new work fits. Not reactive by
 * itself; callers can subscribe for change notifications.
 */
export class MemoryBudget {
  #totalBytes: number;
  readonly #allocations = new Map<string, MemoryAllocation>();
  readonly #listeners = new Set<() => void>();

  constructor(totalBytes: number = resolveDefaultBudgetBytes()) {
    this.#totalBytes = totalBytes;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  /** Adjust the ceiling (device-derived default or user override). */
  setTotalBytes(bytes: number): void {
    this.#totalBytes = Math.max(0, bytes);
    this.#emit();
  }

  register(allocation: MemoryAllocation): void {
    this.#allocations.set(allocation.key, allocation);
    this.#emit();
  }

  release(key: string): void {
    if (this.#allocations.delete(key)) {
      this.#emit();
    }
  }

  has(key: string): boolean {
    return this.#allocations.has(key);
  }

  allocations(): MemoryAllocation[] {
    return [...this.#allocations.values()];
  }

  usedBytes(): number {
    let total = 0;
    for (const allocation of this.#allocations.values()) {
      total += allocation.bytes;
    }
    return total;
  }

  freeBytes(): number {
    return Math.max(0, this.#totalBytes - this.usedBytes());
  }

  /** Bytes reclaimable by evicting non-pipeline (chat) allocations. */
  reclaimableBytes(): number {
    let total = 0;
    for (const allocation of this.#allocations.values()) {
      if (allocation.evictable) {
        total += allocation.bytes;
      }
    }
    return total;
  }

  /**
   * Decide whether a chat footprint of `requiredBytes` can run. Recording
   * always wins: only evictable (chat) allocations count as reclaimable, never
   * the pipeline. Excluding a caller's own prior chat allocations lets a thread
   * re-admit itself without double-counting.
   */
  admitChat(requiredBytes: number, ownKeys: string[] = []): ChatAdmission {
    const ownBytes = ownKeys.reduce(
      (total, key) => total + (this.#allocations.get(key)?.bytes ?? 0),
      0,
    );
    const reclaimable = this.reclaimableBytes() - ownBytes;
    const availableBytes = this.freeBytes() + Math.max(0, reclaimable) + ownBytes;

    if (requiredBytes <= availableBytes) {
      return {
        ok: true,
        projectedBytes: requiredBytes,
        freeBytes: availableBytes,
      };
    }

    return {
      ok: false,
      reason:
        'Not enough memory for chat right now. Free memory (recording keeps priority) or choose a smaller language model.',
      requiredBytes,
      freeBytes: availableBytes,
    };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
