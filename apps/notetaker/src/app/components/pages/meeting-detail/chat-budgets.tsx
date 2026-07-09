import type { MemorySnapshot } from '../../../chat/budget-format';
import { formatTokens, percentOf } from '../../../chat/budget-format';
import { formatBytes } from '../../../utils/formatters';
import styles from '../../../app.module.css';

interface ChatBudgetsProps {
  memory: MemorySnapshot | null;
  /** Approximate tokens the active thread currently holds. */
  threadTokens: number;
  /** Prompt token budget before older turns are dropped. */
  tokenBudget: number;
}

const SEGMENT_CLASS: Record<string, string> = {
  language: styles.budgetSegLanguage,
  kv: styles.budgetSegKv,
  transcription: styles.budgetSegPipeline,
  diarization: styles.budgetSegPipeline,
};

export function ChatBudgets({
  memory,
  threadTokens,
  tokenBudget,
}: ChatBudgetsProps) {
  const tokenPercent = percentOf(threadTokens, tokenBudget);

  return (
    <div className={styles.budgets}>
      <div className={styles.budgetRow}>
        <div className={styles.budgetLabel}>
          <span>Memory</span>
          {memory !== null ? (
            <small className={memory.overBudget ? styles.budgetOver : undefined}>
              {formatBytes(memory.usedBytes)} / {formatBytes(memory.totalBytes)}
            </small>
          ) : (
            <small>…</small>
          )}
        </div>
        <div
          className={styles.budgetBar}
          role="img"
          aria-label={
            memory !== null
              ? `Memory ${formatBytes(memory.usedBytes)} of ${formatBytes(memory.totalBytes)}`
              : 'Memory budget loading'
          }
        >
          {memory?.segments.map((segment) => (
            <span
              key={segment.key}
              className={`${styles.budgetSeg} ${SEGMENT_CLASS[segment.key] ?? styles.budgetSegKv}`}
              style={{ width: `${percentOf(segment.bytes, memory.totalBytes)}%` }}
              title={`${segment.label}: ${formatBytes(segment.bytes)}`}
            />
          ))}
        </div>
        {memory !== null ? (
          <div className={styles.budgetLegend}>
            {memory.segments.map((segment) => (
              <span key={segment.key}>
                <i
                  className={`${styles.budgetDot} ${SEGMENT_CLASS[segment.key] ?? styles.budgetSegKv}`}
                />
                {segment.label} {formatBytes(segment.bytes)}
              </span>
            ))}
            <span>{formatBytes(memory.freeBytes)} free</span>
          </div>
        ) : null}
      </div>

      <div className={styles.budgetRow}>
        <div className={styles.budgetLabel}>
          <span>Chat context</span>
          <small className={tokenPercent >= 100 ? styles.budgetOver : undefined}>
            {formatTokens(threadTokens)} / {formatTokens(tokenBudget)} tokens
          </small>
        </div>
        <div
          className={styles.budgetBar}
          role="img"
          aria-label={`Chat context ${formatTokens(threadTokens)} of ${formatTokens(tokenBudget)} tokens`}
        >
          <span
            className={`${styles.budgetSeg} ${styles.budgetSegTokens}`}
            style={{ width: `${tokenPercent}%` }}
          />
        </div>
        {tokenPercent >= 100 ? (
          <div className={styles.budgetLegend}>
            <span>Oldest messages drop out of context as new ones arrive.</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
