import type { ChangeEvent, Dispatch, RefObject, SetStateAction } from 'react';
import type {
  EngineProgressEvent,
  EngineStage,
  SpeakerTurn,
} from '@notetaker/engine';
import type { ModelVersionManifestEntry } from '@notetaker/model-manager';
import styles from '../app.module.css';
import { DebugLogPanel } from './debug-log-panel';
import { ExportControls } from './export-controls';

type EngineStatus = 'idle' | 'processing' | 'error';

interface MeetingOption {
  id: string;
  name: string;
  date: string;
}

interface DiarizationPageProps {
  engineStatus: EngineStatus;
  engineMessage: string;
  engineProgress: Record<
    EngineStage,
    EngineProgressEvent['status'] | undefined
  >;
  engineBarValue: number | null;
  selectedMeetingId: string;
  meetings: MeetingOption[];
  numSpeakersHint: number | null;
  diarizationResult: SpeakerTurn[] | null;
  engineLog: string[];
  engineLogRef: RefObject<HTMLDivElement | null>;
  activePyannote: ModelVersionManifestEntry | undefined;
  onSelectedMeetingIdChange: (id: string) => void;
  onNumSpeakersHintChange: Dispatch<SetStateAction<number | null>>;
  onRunDiarization: () => void;
  getModelVersionTitle: (version: ModelVersionManifestEntry) => string;
  formatTimestamp: (seconds: number) => string;
}

export function DiarizationPage({
  engineStatus,
  engineMessage,
  engineProgress,
  engineBarValue,
  selectedMeetingId,
  meetings,
  numSpeakersHint,
  diarizationResult,
  engineLog,
  engineLogRef,
  activePyannote,
  onSelectedMeetingIdChange,
  onNumSpeakersHintChange,
  onRunDiarization,
  getModelVersionTitle,
  formatTimestamp,
}: DiarizationPageProps) {
  return (
    <section className={styles.panel}>
      <div className={styles.listHeader}>
        <div>
          <p className={styles.label}>Diarization</p>
          <h2>Run Pyannote only</h2>
        </div>
        <span data-state={engineStatus}>{engineStatus}</span>
      </div>
      <p className={styles.message}>{engineMessage}</p>

      <div className={styles.engineModelGrid}>
        <div className={styles.engineModelPicker}>
          <span>Pyannote model</span>
          <strong>
            {activePyannote === undefined
              ? 'No active version'
              : getModelVersionTitle(activePyannote)}
          </strong>
        </div>
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

      <ul className={styles.engineProgress}>
        <li data-status={engineProgress.diarization ?? 'pending'}>
          <span>Diarization</span>
          <small>{engineProgress.diarization ?? 'pending'}</small>
        </li>
      </ul>

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
          onClick={onRunDiarization}
          disabled={
            selectedMeetingId.length === 0 || engineStatus === 'processing'
          }
        >
          Diarize Only
        </button>
      </div>

      <DebugLogPanel
        lines={engineLog}
        emptyText="Waiting for output..."
        logRef={engineLogRef}
      />

      {diarizationResult !== null ? (
        <div className={styles.transcriptResult}>
          <div className={styles.resultHeader}>
            <h3>
              Speaker turns -{' '}
              {[...new Set(diarizationResult.map((t) => t.speaker))].length}{' '}
              speaker
              {[...new Set(diarizationResult.map((t) => t.speaker))].length ===
              1
                ? ''
                : 's'}
              , {diarizationResult.length} turn
              {diarizationResult.length === 1 ? '' : 's'}
            </h3>
            <ExportControls
              json={diarizationResult}
              jsonFileName="diarization.json"
            />
          </div>
          <ul>
            {diarizationResult.map((turn, index) => (
              <li key={`${turn.startSeconds}-${index}`}>
                <strong>{turn.speaker}</strong>
                <span>
                  {formatTimestamp(turn.startSeconds)} to{' '}
                  {formatTimestamp(turn.endSeconds)} (
                  {(turn.endSeconds - turn.startSeconds).toFixed(1)}s)
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
