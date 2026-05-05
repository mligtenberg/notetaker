import { useEffect, useRef } from 'react';
import type { EngineStatus, LiveTranscriptSegment } from '../app.types';
import styles from '../app.module.css';

interface EngineLogDialogProps {
  mode: 'engine' | 'transcription';
  status: EngineStatus;
  meetingName: string;
  logLines: string[];
  liveTranscriptSegments: LiveTranscriptSegment[];
  onClose: () => void;
}

export function EngineLogDialog({
  mode,
  status,
  meetingName,
  logLines,
  liveTranscriptSegments,
  onClose,
}: EngineLogDialogProps) {
  const engineLogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = engineLogRef.current;

    if (node !== null) {
      node.scrollTop = node.scrollHeight;
    }
  }, [logLines]);

  return (
    <div
      className={styles.downloadOverlay}
      role="dialog"
      aria-modal="true"
      aria-label="Transcription progress"
    >
      <section className={styles.downloadDialog}>
        <div className={styles.listHeader}>
          <div>
            <p className={styles.label}>
              {mode === 'transcription' ? 'Transcription' : 'Engine'}
            </p>
            <h2>
              {mode === 'transcription' ? 'Transcribing' : 'Processing'}{' '}
              {meetingName}
            </h2>
          </div>
          <span data-state={status}>{status}</span>
        </div>

        {mode === 'transcription' ? (
          <div className={styles.liveTranscript}>
            <div className={styles.liveTranscriptHeader}>
              <strong>Live transcript</strong>
              <span>{liveTranscriptSegments.length} segments</span>
            </div>
            {liveTranscriptSegments.length === 0 ? (
              <p className={styles.empty}>Waiting for speech...</p>
            ) : (
              <div className={styles.liveTranscriptBody}>
                {liveTranscriptSegments.map((segment, index) => (
                  <p key={`${segment.startSeconds}-${index}`}>
                    <span>{segment.text}</span>
                  </p>
                ))}
              </div>
            )}
          </div>
        ) : null}

        <div ref={engineLogRef} className={styles.engineLog}>
          {logLines.length === 0 ? (
            <p className={styles.empty}>Waiting for output...</p>
          ) : (
            logLines.map((line, index) => (
              <p key={`${index}-${line.slice(0, 32)}`}>{line}</p>
            ))
          )}
        </div>

        <button type="button" onClick={onClose}>
          {status === 'processing' ? 'Hide' : 'Close'}
        </button>
      </section>
    </div>
  );
}
