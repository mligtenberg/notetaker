import type { ChangeEvent, Dispatch, SetStateAction } from 'react';
import type {
  EngineProgressEvent,
  EngineStage,
  MeetingNotes,
} from '@notetaker/engine';
import type {
  ManagedModel,
  ModelVersionManifestEntry,
} from '@notetaker/model-manager';
import styles from '../app.module.css';
import { DebugLogPanel } from './debug-log-panel';

type EngineStatus = 'idle' | 'processing' | 'error';
type WebGpuSupport = 'checking' | 'supported' | 'unsupported';

interface StoredAudioFile {
  name: string;
  updatedAt: number;
}

interface ModelDownloadTarget {
  model: ManagedModel;
  label: string;
}

interface LiveTranscriptSegment {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

interface EnginePageProps {
  engineStatus: EngineStatus;
  engineMessage: string;
  webGpuSupport: WebGpuSupport;
  engineProgress: Record<
    EngineStage,
    EngineProgressEvent['status'] | undefined
  >;
  selectedAudioName: string;
  files: StoredAudioFile[];
  meetingNotes: MeetingNotes | null;
  engineLog: string[];
  engineBarValue: number | null;
  liveTranscriptSegments: LiveTranscriptSegment[];
  numSpeakersHint: number | null;
  modelTargets: ModelDownloadTarget[];
  onSelectedAudioNameChange: (name: string) => void;
  onNumSpeakersHintChange: Dispatch<SetStateAction<number | null>>;
  onRunEngine: () => void;
  getWebGpuSupportLabel: (support: WebGpuSupport) => string;
  getActiveModelVersion: (
    model: ManagedModel,
  ) => ModelVersionManifestEntry | undefined;
  getModelVersionTitle: (version: ModelVersionManifestEntry) => string;
}

export function EnginePage({
  engineStatus,
  engineMessage,
  webGpuSupport,
  engineProgress,
  selectedAudioName,
  files,
  meetingNotes,
  engineLog,
  engineBarValue,
  liveTranscriptSegments,
  numSpeakersHint,
  modelTargets,
  onSelectedAudioNameChange,
  onNumSpeakersHintChange,
  onRunEngine,
  getWebGpuSupportLabel,
  getActiveModelVersion,
  getModelVersionTitle,
}: EnginePageProps) {
  return (
    <section className={styles.panel}>
      <div className={styles.listHeader}>
        <div>
          <p className={styles.label}>Engine</p>
          <h2>Process a meeting</h2>
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

      <ul className={styles.engineProgress}>
        {(
          [
            ['transcription', 'Transcription'],
            ['diarization', 'Diarization'],
            ['speaker-naming', 'Speaker naming'],
          ] as const
        ).map(([stage, label]) => (
          <li key={stage} data-status={engineProgress[stage] ?? 'pending'}>
            <span>{label}</span>
            <small>{engineProgress[stage] ?? 'pending'}</small>
          </li>
        ))}
      </ul>

      <div className={styles.engineModelGrid}>
        {modelTargets.map((target) => {
          const activeModel = getActiveModelVersion(target.model);

          return (
            <div key={target.model} className={styles.engineModelPicker}>
              <span>{target.label} model</span>
              <strong>
                {activeModel === undefined
                  ? 'No active version'
                  : getModelVersionTitle(activeModel)}
              </strong>
            </div>
          );
        })}
        <label className={styles.engineModelPicker}>
          <span>Number of speakers (optional)</span>
          <input
            type="number"
            min={1}
            max={10}
            placeholder="Auto-detect"
            value={numSpeakersHint ?? ''}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const val = event.target.value;
              onNumSpeakersHintChange(
                val === '' ? null : Math.max(1, parseInt(val, 10)),
              );
            }}
            disabled={engineStatus === 'processing'}
          />
        </label>
      </div>

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
          onClick={onRunEngine}
          disabled={
            selectedAudioName.length === 0 || engineStatus === 'processing'
          }
        >
          Run Engine
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

      {meetingNotes !== null ? (
        <div className={styles.transcriptResult}>
          <h3>{meetingNotes.meeting.title}</h3>
          <p>{meetingNotes.transcript.text}</p>
          <ul>
            {meetingNotes.transcript.segments.map((segment, index) => (
              <li key={`${segment.startSeconds}-${index}`}>
                <strong>{segment.speakerName}</strong>
                <span>{segment.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
