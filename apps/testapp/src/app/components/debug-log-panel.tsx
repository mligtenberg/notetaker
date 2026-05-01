import type { RefObject } from 'react';
import styles from '../app.module.css';

interface DebugLogPanelProps {
  lines: string[];
  emptyText?: string;
  logRef?: RefObject<HTMLDivElement | null>;
}

export function DebugLogPanel({
  lines,
  emptyText = 'Waiting for debug output...',
  logRef,
}: DebugLogPanelProps) {
  return (
    <div ref={logRef} className={styles.engineLog}>
      {lines.length === 0 ? (
        <p className={styles.empty}>{emptyText}</p>
      ) : (
        lines.map((line, index) => (
          <p key={`${index}-${line.slice(0, 32)}`}>{line}</p>
        ))
      )}
    </div>
  );
}
