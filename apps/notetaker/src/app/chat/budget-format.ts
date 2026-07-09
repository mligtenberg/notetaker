export interface BudgetSegment {
  key: string;
  label: string;
  bytes: number;
}

export interface MemorySnapshot {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** True when projected use exceeds the budget (chat would be refused). */
  overBudget: boolean;
  segments: BudgetSegment[];
}

/** Sum segment bytes against a total into a display snapshot. */
export function summarizeMemory(
  segments: BudgetSegment[],
  totalBytes: number,
): MemorySnapshot {
  const usedBytes = segments.reduce((total, s) => total + s.bytes, 0);
  return {
    totalBytes,
    usedBytes,
    freeBytes: Math.max(0, totalBytes - usedBytes),
    overBudget: usedBytes > totalBytes,
    segments,
  };
}

/** Percent of the total a byte amount occupies, clamped to [0, 100]. */
export function percentOf(bytes: number, totalBytes: number): number {
  if (totalBytes <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (bytes / totalBytes) * 100));
}

/** Compact token count: 1234 → "1.2k". */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return `${tokens}`;
  }
  return `${(tokens / 1000).toFixed(1)}k`;
}
