import type { ChangeEvent } from 'react';
import type { EngineProgressEvent, EngineStage, Transcript } from '@notetaker/engine';
import type { ModelVersionManifestEntry } from '@notetaker/model-manager';
import styles from '../app.module.css';
import { DebugLogPanel } from './debug-log-panel';

type EngineStatus = 'idle' | 'processing' | 'error';
type WebGpuSupport = 'checking' | 'supported' | 'unsupported';

interface StoredAudioFile {
  name: string;
  updatedAt: number;
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
  engineProgress: Record<EngineStage, EngineProgressEvent['status'] | undefined>;
  selectedAudioName: string;
  files: StoredAudioFile[];
  transcriptionResult: Transcript | null;
  engineLog: string[];
  engineBarValue: number | null;
  liveTranscriptSegments: LiveTranscriptSegment[];
  activeWhisper: ModelVersionManifestEntry | undefined;
  onSelectedAudioNameChange: (name: string) => void;
  onRunTranscription: () => void;
  getWebGpuSupportLabel: (support: WebGpuSupport) => string;
  getModelVersionTitle: (version: ModelVersionManifestEntry) => string;
}

export function TranscriptionPage({
  engineStatus,
  engineMessage,
  webGpuSupport,
  engineProgress,
  selectedAudioName,
  files,
  transcriptionResult,
  engineLog,
  engineBarValue,
  liveTranscriptSegments,
  activeWhisper,
  onSelectedAudioNameChange,
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
          value={selectedAudioName}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            onSelectedAudioNameChange(event.target.value)
          }
          disabled={files.length === 0 || engineStatus === 'processing'}
        >
          <option value="">Select recording</option>
          {files.map((file) => (
            <option key={`${file.name}-${file.updatedAt}`} value={file.name}>
              {file.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onRunTranscription}
          disabled={
            selectedAudioName.length === 0 || engineStatus === 'processing'
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
              engineBarValue !== null ? { width: `${engineBarValue}%` } : undefined
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
          <h3>Transcript</h3>
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
