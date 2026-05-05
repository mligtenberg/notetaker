import { useEffect, useRef } from 'react';
import type { EngineStatus, LiveTranscriptSegment } from '../app.types';
import styles from '../app.module.css';
import { Dialog } from './dialog';

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
    <Dialog
      ariaLabel="Transcription progress"
      label={mode === 'transcription' ? 'Transcription' : 'Engine'}
      title={
        <>
          {mode === 'transcription' ? 'Transcribing' : 'Processing'}{' '}
          {meetingName}
        </>
      }
      status={<span data-state={status}>{status}</span>}
      actions={
        <button type="button" onClick={onClose}>
          {status === 'processing' ? 'Hide' : 'Close'}
        </button>
      }
    >
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
    </Dialog>
  );
}
