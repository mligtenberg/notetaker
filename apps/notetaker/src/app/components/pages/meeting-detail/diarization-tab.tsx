import {
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { SpeakerTurn } from '@notetaker/engine';
import type { MeetingArtifactKind } from '@notetaker/filesystem';
import styles from '../../../app.module.css';
import { ExportControls } from '../export-controls';
import {
  RecordingPlayback,
  SpeakerContextMenu,
  collectSpeakers,
  displaySpeakerName,
  mergeSpeakerTurns,
  openSpeakerContextMenu,
  playRecordingFrom,
  renumberSpeakersSequentially,
  saveSpeakerNameArtifact,
  speakerTurnsEqual,
  useSpeakerNames,
} from './shared';
import type { MediaElementRef, SpeakerContextMenuState } from './types';

interface DiarizationArtifactViewProps {
  meetingId: string;
  meetingName: string;
  meetingUrl: string | undefined;
  audioRef: MediaElementRef;
  recordingMimeType: string | null;
  turns: SpeakerTurn[];
  setTurns: Dispatch<SetStateAction<SpeakerTurn[] | null>>;
  loadArtifact: <U>(
    meetingId: string,
    kind: MeetingArtifactKind,
  ) => Promise<U | null>;
  saveArtifact: <U>(
    meetingId: string,
    kind: MeetingArtifactKind,
    data: U,
  ) => Promise<void>;
  onSpeakerNamesSaved: () => void;
  formatTimestamp: (seconds: number) => string;
}

export function DiarizationArtifactView({
  meetingId,
  meetingName,
  meetingUrl,
  audioRef,
  recordingMimeType,
  turns,
  setTurns,
  loadArtifact,
  saveArtifact,
  onSpeakerNamesSaved,
  formatTimestamp,
}: DiarizationArtifactViewProps) {
  const [speakerMenu, setSpeakerMenu] =
    useState<SpeakerContextMenuState | null>(null);
  const speakers = collectSpeakers(turns);
  const [speakerNames, setSpeakerNames] = useSpeakerNames(
    meetingId,
    speakers,
    loadArtifact,
  );

  useEffect(() => {
    const normalizedTurns = renumberSpeakersSequentially(turns);

    if (speakerTurnsEqual(turns, normalizedTurns)) {
      return;
    }

    setTurns(normalizedTurns);
    void saveArtifact(meetingId, 'diarization', normalizedTurns);
  }, [meetingId, saveArtifact, setTurns, turns]);

  async function handleMerge(
    sourceSpeaker: string,
    targetSpeaker: string,
  ): Promise<void> {
    const mergedTurns = mergeSpeakerTurns(turns, sourceSpeaker, targetSpeaker);

    await saveArtifact(meetingId, 'diarization', mergedTurns);
    setTurns(mergedTurns);
    setSpeakerMenu(null);
  }

  async function handleRename(speaker: string, name: string): Promise<void> {
    await saveSpeakerNameArtifact(
      meetingId,
      speaker,
      name,
      loadArtifact,
      saveArtifact,
    );
    setSpeakerNames((current) => ({ ...current, [speaker]: name }));
    onSpeakerNamesSaved();
    setSpeakerMenu(null);
  }

  return (
    <div className={styles.transcriptResult}>
      <RecordingPlayback
        audioRef={audioRef}
        meetingUrl={meetingUrl}
        mimeType={recordingMimeType}
      />
      <div className={styles.resultHeader}>
        <h3>
          {speakers.length} speaker{speakers.length === 1 ? '' : 's'},{' '}
          {turns.length} turn{turns.length === 1 ? '' : 's'}
        </h3>
        <ExportControls
          json={turns}
          jsonFileName={`${meetingName}-diarization.json`}
        />
      </div>
      <ul>
        {turns.map((turn, index) => (
          <li
            key={`${turn.startSeconds}-${index}`}
            className={styles.playbackSegment}
            tabIndex={0}
            onContextMenu={(event) =>
              openSpeakerContextMenu(event, turn.speaker, setSpeakerMenu)
            }
            onKeyDown={(event) => {
              if (
                event.key === 'ContextMenu' ||
                (event.shiftKey && event.key === 'F10')
              ) {
                openSpeakerContextMenu(event, turn.speaker, setSpeakerMenu);
              }
            }}
          >
            <div>
              <strong>{displaySpeakerName(turn.speaker, speakerNames)}</strong>
              <span>
                {formatTimestamp(turn.startSeconds)} to{' '}
                {formatTimestamp(turn.endSeconds)} (
                {(turn.endSeconds - turn.startSeconds).toFixed(1)}s)
              </span>
            </div>
            <button
              type="button"
              className={styles.segmentPlayButton}
              aria-label={`Play ${displaySpeakerName(turn.speaker, speakerNames)} from ${formatTimestamp(turn.startSeconds)}`}
              onClick={() =>
                void playRecordingFrom(audioRef, turn.startSeconds)
              }
            >
              ▶
            </button>
          </li>
        ))}
      </ul>
      {speakerMenu !== null ? (
        <SpeakerContextMenu
          speakers={speakers}
          speakerNames={speakerNames}
          state={speakerMenu}
          onRename={handleRename}
          onMerge={handleMerge}
          onClose={() => setSpeakerMenu(null)}
        />
      ) : null}
    </div>
  );
}
