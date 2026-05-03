import type { ChangeEvent } from 'react';
import type {
  EngineProgressEvent,
  EngineStage,
  Transcript,
} from '@notetaker/engine';
import type { ModelVersionManifestEntry } from '@notetaker/model-manager';
import styles from '../app.module.css';
import { DebugLogPanel } from './debug-log-panel';
import { ExportControls } from './export-controls';

type EngineStatus = 'idle' | 'processing' | 'error';
type WebGpuSupport = 'checking' | 'supported' | 'unsupported';

interface MeetingOption {
  id: string;
  name: string;
  date: string;
}

interface LiveTranscriptSegment {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

interface TranscriptionPageProps {
  engineStatus: EngineStatus;
  engineMessage: string;
  webGpuSupport: WebGpuSupport;
  engineProgress: Record<
    EngineStage,
    EngineProgressEvent['status'] | undefined
  >;
  selectedMeetingId: string;
  meetings: MeetingOption[];
  transcriptionResult: Transcript | null;
  engineLog: string[];
  engineBarValue: number | null;
  liveTranscriptSegments: LiveTranscriptSegment[];
  activeWhisper: ModelVersionManifestEntry | undefined;
  onSelectedMeetingIdChange: (id: string) => void;
  onRunTranscription: () => void;
  getWebGpuSupportLabel: (support: WebGpuSupport) => string;
  getModelVersionTitle: (version: ModelVersionManifestEntry) => string;
}

export function TranscriptionPage({
  engineStatus,
  engineMessage,
  webGpuSupport,
  engineProgress,
  selectedMeetingId,
  meetings,
  transcriptionResult,
  engineLog,
  engineBarValue,
  liveTranscriptSegments,
  activeWhisper,
  onSelectedMeetingIdChange,
  onRunTranscription,
  getWebGpuSupportLabel,
  getModelVersionTitle,
}: TranscriptionPageProps) {
  return (
    <section className={styles.panel}>
      <div className={styles.listHeader}>
        <div>
          <p className={styles.label}>Transcription</p>
          <h2>Run Whisper only</h2>
        </div>
        <span data-state={engineStatus}>{engineStatus}</span>
      </div>
      <p className={styles.message}>{engineMessage}</p>

      <div className={styles.runtimeStatus} data-state={webGpuSupport}>
        <strong>{getWebGpuSupportLabel(webGpuSupport)}</strong>
        <span>
          {webGpuSupport === 'supported'
            ? 'Whisper is pinned to WASM; current q8 ONNX exports fail in ORT Web.'
            : 'Whisper will run on the WASM backend.'}
        </span>
      </div>

      <div className={styles.engineModelGrid}>
        <div className={styles.engineModelPicker}>
          <span>Whisper model</span>
          <strong>
            {activeWhisper === undefined
              ? 'No active version'
              : getModelVersionTitle(activeWhisper)}
          </strong>
        </div>
      </div>

      <ul className={styles.engineProgress}>
        <li data-status={engineProgress.transcription ?? 'pending'}>
          <span>Transcription</span>
          <small>{engineProgress.transcription ?? 'pending'}</small>
        </li>
      </ul>

      <div className={styles.engineControls}>
        <select
          value={selectedMeetingId}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            onSelectedMeetingIdChange(event.target.value)
          }
          disabled={meetings.length === 0 || engineStatus === 'processing'}
        >
          <option value="">Select meeting</option>
          {meetings.map((meeting) => (
            <option key={meeting.id} value={meeting.id}>
              {meeting.name} ({meeting.date})
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onRunTranscription}
          disabled={
            selectedMeetingId.length === 0 || engineStatus === 'processing'
          }
        >
          Transcribe Only
        </button>
      </div>

      {engineBarValue !== null || engineStatus === 'processing' ? (
        <div className={styles.progressTrack} aria-hidden="true">
          <div
            data-indeterminate={
              engineBarValue === null && engineStatus === 'processing'
            }
            style={
              engineBarValue !== null
                ? { width: `${engineBarValue}%` }
                : undefined
            }
          />
        </div>
      ) : null}

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

      <DebugLogPanel lines={engineLog} />

      {transcriptionResult !== null ? (
        <div className={styles.transcriptResult}>
          <div className={styles.resultHeader}>
            <h3>Transcript</h3>
            <ExportControls
              json={transcriptionResult}
              jsonFileName="transcript.json"
              text={transcriptionResult.text}
              textFileName="transcript.txt"
            />
          </div>
          <p>{transcriptionResult.text}</p>
          <ul>
            {transcriptionResult.segments.map((segment, index) => (
              <li key={`${segment.startSeconds}-${index}`}>
                <span>{segment.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
