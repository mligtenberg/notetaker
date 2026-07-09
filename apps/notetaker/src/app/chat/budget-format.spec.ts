import { describe, expect, it } from 'vitest';
import { formatTokens, percentOf, summarizeMemory } from './budget-format';

describe('summarizeMemory', () => {
  it('sums segments and reports free headroom', () => {
    const snapshot = summarizeMemory(
      [
        { key: 'language', label: 'Language model', bytes: 2_000_000_000 },
        { key: 'kv', label: 'KV', bytes: 200_000_000 },
      ],
      4_000_000_000,
    );
    expect(snapshot.usedBytes).toBe(2_200_000_000);
    expect(snapshot.freeBytes).toBe(1_800_000_000);
    expect(snapshot.overBudget).toBe(false);
  });

  it('flags going over budget and clamps free to zero', () => {
    const snapshot = summarizeMemory(
      [{ key: 'language', label: 'L', bytes: 5_000_000_000 }],
      4_000_000_000,
    );
    expect(snapshot.overBudget).toBe(true);
    expect(snapshot.freeBytes).toBe(0);
  });
});

describe('percentOf', () => {
  it('computes a clamped percentage', () => {
    expect(percentOf(1, 4)).toBe(25);
    expect(percentOf(8, 4)).toBe(100);
    expect(percentOf(1, 0)).toBe(0);
  });
});

describe('formatTokens', () => {
  it('formats small and large counts', () => {
    expect(formatTokens(512)).toBe('512');
    expect(formatTokens(7168)).toBe('7.2k');
  });
});
