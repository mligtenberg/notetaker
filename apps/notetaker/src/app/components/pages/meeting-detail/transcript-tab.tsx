import {
  useEffect,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type SetStateAction,
} from 'react';
import type { Transcript } from '@notetaker/engine';
import type { MeetingDerivationKind } from '@notetaker/filesystem';
import styles from '../../../app.module.css';
import { ExportControls } from '../export-controls';
import { EditSegmentDialog, RecordingPlayback, playRecordingFrom } from './shared';
import type {
  LiveTranscriptSegment,
  MediaElementRef,
  TranscriptSegmentMenuState,
} from './types';

interface TranscriptArtifactViewProps {
  meetingId: string;
  meetingName: string;
  meetingUrl: string | undefined;
  audioRef: MediaElementRef;
  recordingMimeType: string | null;
  transcript: Transcript;
  setTranscript: Dispatch<SetStateAction<Transcript | null>>;
  saveDerivation: <U>(
    meetingId: string,
    kind: MeetingDerivationKind,
    data: U,
  ) => Promise<void>;
  deleteDerivation: (
    meetingId: string,
    kind: MeetingDerivationKind,
  ) => Promise<void>;
  formatTimestamp: (seconds: number) => string;
}

export function TranscriptArtifactView({
  meetingId,
  meetingName,
  meetingUrl,
  audioRef,
  recordingMimeType,
  transcript,
  setTranscript,
  saveDerivation,
  deleteDerivation,
  formatTimestamp,
}: TranscriptArtifactViewProps) {
  const [segmentMenu, setSegmentMenu] =
    useState<TranscriptSegmentMenuState | null>(null);

  async function handleEditSegment(
    segmentIndex: number,
    text: string,
  ): Promise<void> {
    const nextSegments = transcript.segments.map((segment, index) =>
      index === segmentIndex ? { ...segment, text } : segment,
    );
    const nextTranscript = {
      ...transcript,
      text: nextSegments.map((segment) => segment.text).join(' '),
      segments: nextSegments,
    };

    await saveDerivation(meetingId, 'transcript', nextTranscript);
    await deleteDerivation(meetingId, 'word-sync');
    await deleteDerivation(meetingId, 'speaker-names');
    setTranscript(nextTranscript);
    setSegmentMenu(null);
  }

  return (
    <div className={styles.transcriptResult}>
      <RecordingPlayback
        audioRef={audioRef}
        meetingUrl={meetingUrl}
        mimeType={recordingMimeType}
      />
      <div className={styles.resultHeader}>
        <h3>Transcript</h3>
        <ExportControls
          json={transcript}
          jsonFileName={`${meetingName}-transcript.json`}
          text={transcript.text}
          textFileName={`${meetingName}-transcript.txt`}
        />
      </div>
      <ul>
        {transcript.segments.map((segment, index) => (
          <li
            key={`${segment.startSeconds}-${index}`}
            className={styles.playbackSegment}
            tabIndex={0}
            onContextMenu={(event) =>
              openTranscriptSegmentMenu(event, index, setSegmentMenu)
            }
            onKeyDown={(event) => {
              if (
                event.key === 'ContextMenu' ||
                (event.shiftKey && event.key === 'F10')
              ) {
                openTranscriptSegmentMenu(event, index, setSegmentMenu);
              }
            }}
          >
            <div>
              <strong>[{formatTimestamp(segment.startSeconds)}]</strong>
              <span>{segment.text}</span>
            </div>
            <button
              type="button"
              className={styles.segmentPlayButton}
              aria-label={`Play transcript segment from ${formatTimestamp(segment.startSeconds)}`}
              onClick={() =>
                void playRecordingFrom(audioRef, segment.startSeconds)
              }
            >
              ▶
            </button>
          </li>
        ))}
      </ul>
      {segmentMenu !== null ? (
        <TranscriptSegmentContextMenu
          state={segmentMenu}
          segmentText={transcript.segments[segmentMenu.segmentIndex]?.text ?? ''}
          onEdit={handleEditSegment}
          onClose={() => setSegmentMenu(null)}
        />
      ) : null}
    </div>
  );
}

interface LiveTranscriptPreviewProps {
  segments: LiveTranscriptSegment[];
}

export function LiveTranscriptPreview({ segments }: LiveTranscriptPreviewProps) {
  return (
    <div className={styles.transcriptResult}>
      <div className={styles.resultHeader}>
        <h3>Live transcript</h3>
        <span>
          {segments.length} segment{segments.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul>
        {segments.map((segment, index) => (
          <li key={`${segment.startSeconds}-${index}`}>
            <span>{segment.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface TranscriptSegmentContextMenuProps {
  state: TranscriptSegmentMenuState;
  segmentText: string;
  onEdit: (segmentIndex: number, text: string) => Promise<void>;
  onClose: () => void;
}

function TranscriptSegmentContextMenu({
  state,
  segmentText,
  onEdit,
  onClose,
}: TranscriptSegmentContextMenuProps) {
  const [mode, setMode] = useState<'menu' | 'edit'>('menu');
  const [text, setText] = useState(segmentText);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (mode === 'edit') {
      return;
    }

    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    function handleClick(): void {
      onClose();
    }

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('click', handleClick);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('click', handleClick);
    };
  }, [onClose, mode]);

  async function handleSave(): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }

    setSaving(true);
    try {
      await onEdit(state.segmentIndex, trimmed);
    } finally {
      setSaving(false);
    }
  }

  if (mode === 'edit') {
    return (
      <EditSegmentDialog
        label="Transcript"
        title="Edit segment"
        text={text}
        saving={saving}
        onChangeText={setText}
        onSave={() => void handleSave()}
        onCancel={onClose}
      />
    );
  }

  return (
    <div
      className={styles.speakerMergePopover}
      style={{ left: state.x, top: state.y }}
      onClick={(event) => event.stopPropagation()}
    >
      <strong>Transcript segment</strong>
      <button type="button" onClick={() => setMode('edit')}>
        <span aria-hidden="true">✎</span>
        Edit
      </button>
      <button type="button" onClick={onClose}>
        <span aria-hidden="true">×</span>
        Cancel
      </button>
    </div>
  );
}

function openTranscriptSegmentMenu(
  event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
  segmentIndex: number,
  setSegmentMenu: Dispatch<SetStateAction<TranscriptSegmentMenuState | null>>,
): void {
  event.preventDefault();
  event.stopPropagation();

  if ('clientX' in event && event.clientX !== 0 && event.clientY !== 0) {
    setSegmentMenu({ segmentIndex, x: event.clientX, y: event.clientY });
    return;
  }

  const rect = event.currentTarget.getBoundingClientRect();
  setSegmentMenu({
    segmentIndex,
    x: rect.left + 16,
    y: rect.top + 16,
  });
}
