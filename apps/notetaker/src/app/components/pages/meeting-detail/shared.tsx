import {
  useEffect,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type SetStateAction,
} from 'react';
import type { SpeakerTurn } from '@notetaker/engine';
import type { MeetingDerivationKind } from '@notetaker/filesystem';
import styles from '../../../app.module.css';
import { Dialog } from '../../common/dialog';
import { type MeetingTab } from '../../../app-routing';
import type {
  MediaElementRef,
  SpeakerContextMenuMode,
  SpeakerContextMenuState,
  SpeakerWordTurn,
  WordAssignmentPopoverState,
} from './types';

interface ArtifactToolbarProps {
  label: string;
  running: boolean;
  disabled: boolean;
  disabledReason: string | null;
  engineMessage: string;
  onRun: () => void;
  onOpenLogging: () => void;
  showLogging: boolean;
}

export function ArtifactToolbar({
  label,
  running,
  disabled,
  disabledReason,
  engineMessage,
  onRun,
  onOpenLogging,
  showLogging,
}: ArtifactToolbarProps) {
  return (
    <div className={styles.artifactToolbar}>
      <div>
        <button type="button" onClick={onRun} disabled={disabled}>
          {running ? 'Running...' : label}
        </button>
        {disabledReason !== null ? (
          <small>{disabledReason}</small>
        ) : engineMessage.length > 0 && running ? (
          <small>{engineMessage}</small>
        ) : null}
        {showLogging ? (
          <button
            type="button"
            className={styles.textButton}
            onClick={onOpenLogging}
          >
            Open logging
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface RecordingPlaybackProps {
  audioRef: MediaElementRef;
  meetingUrl: string | undefined;
  mimeType: string | null;
}

export function RecordingPlayback({
  audioRef,
  meetingUrl,
  mimeType,
}: RecordingPlaybackProps) {
  if (meetingUrl === undefined) {
    return <p className={styles.empty}>No recording available for playback.</p>;
  }

  return (
    <div
      className={`${styles.recordingPlayback} ${styles.stickyRecordingPlayback}`}
    >
      <RecordingMedia
        mediaRef={audioRef}
        meetingUrl={meetingUrl}
        mimeType={mimeType}
      />
    </div>
  );
}

interface RecordingMediaProps {
  mediaRef: MediaElementRef | null;
  meetingUrl: string;
  mimeType: string | null;
}

export function RecordingMedia({
  mediaRef,
  meetingUrl,
  mimeType,
}: RecordingMediaProps) {
  const assignRef = (element: HTMLMediaElement | null) => {
    if (mediaRef !== null) {
      mediaRef.current = element;
    }
  };

  if (isVideoMimeType(mimeType)) {
    return <video ref={assignRef} controls src={meetingUrl} />;
  }

  return <audio ref={assignRef} controls src={meetingUrl} />;
}

export function isVideoMimeType(mimeType: string | null): boolean {
  return mimeType?.startsWith('video/') ?? false;
}

export async function playRecordingFrom(
  audioRef: MediaElementRef,
  startSeconds: number,
): Promise<void> {
  const media = audioRef.current;

  if (media === null) {
    return;
  }

  media.currentTime = Math.max(0, startSeconds);
  await media.play();
}

export async function toggleRecordingPlayback(media: HTMLMediaElement): Promise<void> {
  if (media.paused) {
    await media.play();
    return;
  }

  media.pause();
}

export function getActiveMediaRef(
  activeTab: MeetingTab,
  refs: {
    recording: MediaElementRef;
    transcript: MediaElementRef;
    diarization: MediaElementRef;
    wordSync: MediaElementRef;
  },
): MediaElementRef | null {
  if (activeTab === 'recording') {
    return refs.recording;
  }

  if (activeTab === 'transcript') {
    return refs.transcript;
  }

  if (activeTab === 'diarization') {
    return refs.diarization;
  }

  if (activeTab === 'word-sync') {
    return refs.wordSync;
  }

  return null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

export function displaySpeakerName(
  speaker: string,
  speakerNames: Record<string, string>,
): string {
  const name = speakerNames[speaker]?.trim();

  return name !== undefined && name.length > 0 ? name : speaker;
}

export function useSpeakerNames(
  meetingId: string,
  speakers: string[],
  loadDerivation: <U>(
    meetingId: string,
    kind: MeetingDerivationKind,
  ) => Promise<U | null>,
): [Record<string, string>, Dispatch<SetStateAction<Record<string, string>>>] {
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const speakerKey = speakers.join('\0');

  useEffect(() => {
    let cancelled = false;

    loadDerivation<Record<string, string>>(meetingId, 'speaker-names').then(
      (savedNames) => {
        if (!cancelled) {
          setSpeakerNames(savedNames ?? {});
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [meetingId, speakerKey, loadDerivation]);

  return [speakerNames, setSpeakerNames];
}

export async function saveSpeakerNameArtifact(
  meetingId: string,
  speaker: string,
  name: string,
  loadDerivation: <U>(
    meetingId: string,
    kind: MeetingDerivationKind,
  ) => Promise<U | null>,
  saveDerivation: <U>(
    meetingId: string,
    kind: MeetingDerivationKind,
    data: U,
  ) => Promise<void>,
): Promise<void> {
  const savedNames = await loadDerivation<Record<string, string>>(
    meetingId,
    'speaker-names',
  );

  await saveDerivation(meetingId, 'speaker-names', {
    ...(savedNames ?? {}),
    [speaker]: name,
  });
}

export function collectSpeakers(turns: SpeakerTurn[]): string[] {
  return [...new Set(turns.map((turn) => turn.speaker))].sort();
}

export function getNextSpeakerName(speakers: string[]): string {
  const highestNumber = speakers.reduce((highest, speaker) => {
    const match = /^(.*?)(\d+)$/.exec(speaker);

    if (match === null) {
      return highest;
    }

    return Math.max(highest, Number.parseInt(match[2]!, 10));
  }, -1);
  const templateSpeaker = speakers.find((speaker) => /\d+$/.test(speaker));

  if (templateSpeaker === undefined) {
    return `Speaker ${speakers.length + 1}`;
  }

  const match = /^(.*?)(\d+)$/.exec(templateSpeaker);
  const prefix = match?.[1] ?? 'Speaker ';
  const digitCount = match?.[2]?.length ?? 1;
  const nextNumber = highestNumber + 1;

  return `${prefix}${String(nextNumber).padStart(digitCount, '0')}`;
}

export function mergeSpeakerTurns(
  turns: SpeakerTurn[],
  sourceSpeaker: string,
  targetSpeaker: string,
): SpeakerTurn[] {
  return renumberSpeakersSequentially(
    mergeAdjacentSpeakerTurns(
      turns.map((turn) => ({
        ...turn,
        speaker: turn.speaker === sourceSpeaker ? targetSpeaker : turn.speaker,
      })),
    ),
  );
}

export function renumberSpeakersSequentially(turns: SpeakerTurn[]): SpeakerTurn[] {
  const speakers = collectSpeakers(turns);
  const numberedSpeakers = speakers
    .map((speaker) => ({ speaker, match: /^(.*?)(\d+)$/.exec(speaker) }))
    .filter(
      (
        item,
      ): item is {
        speaker: string;
        match: RegExpExecArray;
      } => item.match !== null,
    );

  if (numberedSpeakers.length !== speakers.length) {
    return turns;
  }

  const prefixes = new Set(numberedSpeakers.map(({ match }) => match[1]));

  if (prefixes.size !== 1) {
    return turns;
  }

  const digitCount = Math.max(
    ...numberedSpeakers.map(({ match }) => match[2]!.length),
  );
  const prefix = numberedSpeakers[0]?.match[1] ?? '';
  const speakerMap = new Map(
    numberedSpeakers.map(({ speaker }, index) => [
      speaker,
      `${prefix}${String(index).padStart(digitCount, '0')}`,
    ]),
  );

  return turns.map((turn) => ({
    ...turn,
    speaker: speakerMap.get(turn.speaker) ?? turn.speaker,
  }));
}

export function speakerTurnsEqual(
  firstTurns: SpeakerTurn[],
  secondTurns: SpeakerTurn[],
): boolean {
  if (firstTurns.length !== secondTurns.length) {
    return false;
  }

  return firstTurns.every((turn, index) => {
    const otherTurn = secondTurns[index];

    return (
      otherTurn !== undefined &&
      turn.speaker === otherTurn.speaker &&
      turn.startSeconds === otherTurn.startSeconds &&
      turn.endSeconds === otherTurn.endSeconds &&
      turn.text === otherTurn.text
    );
  });
}

export function mergeAdjacentSpeakerTurns(turns: SpeakerTurn[]): SpeakerTurn[] {
  const sortedTurns = [...turns].sort(
    (first, second) => first.startSeconds - second.startSeconds,
  );
  const mergedTurns: SpeakerTurn[] = [];

  for (const turn of sortedTurns) {
    if (turn.endSeconds <= turn.startSeconds) {
      continue;
    }

    const previousTurn = mergedTurns.at(-1);

    if (previousTurn !== undefined && previousTurn.speaker === turn.speaker) {
      previousTurn.endSeconds = Math.max(
        previousTurn.endSeconds,
        turn.endSeconds,
      );
      previousTurn.text = [previousTurn.text, turn.text]
        .filter(Boolean)
        .join(' ');
      continue;
    }

    mergedTurns.push({ ...turn });
  }

  return mergedTurns;
}

export function clampBoundarySeconds(
  boundarySeconds: number,
  minSeconds: number,
  maxSeconds: number,
): number {
  return Math.min(Math.max(boundarySeconds, minSeconds), maxSeconds);
}

export function rangesOverlap(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
): boolean {
  return firstStart < secondEnd && secondStart < firstEnd;
}

interface EditSegmentDialogProps {
  label: string;
  title: string;
  text: string;
  saving: boolean;
  onChangeText: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function EditSegmentDialog({
  label,
  title,
  text,
  saving,
  onChangeText,
  onSave,
  onCancel,
}: EditSegmentDialogProps) {
  return (
    <Dialog
      ariaLabel={title}
      label={label}
      title={title}
      actions={
        <div className={styles.dialogActions}>
          <button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || text.trim().length === 0}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      }
    >
      <textarea
        value={text}
        onChange={(event) => onChangeText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            onSave();
          }
          if (event.key === 'Escape') {
            onCancel();
          }
        }}
        disabled={saving}
        autoFocus
      />
    </Dialog>
  );
}

interface SpeakerContextMenuProps {
  speakers: string[];
  speakerNames: Record<string, string>;
  state: SpeakerContextMenuState;
  editText?: string;
  onRename: (speaker: string, name: string) => Promise<void>;
  onMerge: (sourceSpeaker: string, targetSpeaker: string) => Promise<void>;
  onEdit?: (turnIndex: number, text: string) => Promise<void>;
  onClose: () => void;
}

export function SpeakerContextMenu({
  speakers,
  speakerNames,
  state,
  editText,
  onRename,
  onMerge,
  onEdit,
  onClose,
}: SpeakerContextMenuProps) {
  const mergeTargets = speakers.filter(
    (speaker) => speaker !== state.sourceSpeaker,
  );
  const [mode, setMode] = useState<SpeakerContextMenuMode>('menu');
  const [speakerName, setSpeakerName] = useState(
    displaySpeakerName(state.sourceSpeaker, speakerNames),
  );
  const [targetSpeaker, setTargetSpeaker] = useState(mergeTargets[0] ?? '');
  const [text, setText] = useState(editText ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTargetSpeaker((current) =>
      mergeTargets.includes(current) ? current : (mergeTargets[0] ?? ''),
    );
  }, [mergeTargets]);

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

  async function handleRename(): Promise<void> {
    const trimmed = speakerName.trim();
    if (trimmed.length === 0) {
      return;
    }

    setSaving(true);
    try {
      await onRename(state.sourceSpeaker, trimmed);
    } finally {
      setSaving(false);
    }
  }

  async function handleMerge(): Promise<void> {
    if (targetSpeaker.length === 0) {
      return;
    }

    setSaving(true);
    try {
      await onMerge(state.sourceSpeaker, targetSpeaker);
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit(): Promise<void> {
    const trimmed = text.trim();
    if (onEdit === undefined || state.turnIndex === undefined || trimmed.length === 0) {
      return;
    }

    setSaving(true);
    try {
      await onEdit(state.turnIndex, trimmed);
    } finally {
      setSaving(false);
    }
  }

  if (mode === 'edit') {
    return (
      <EditSegmentDialog
        label="Word sync"
        title="Edit segment"
        text={text}
        saving={saving}
        onChangeText={setText}
        onSave={() => void handleEdit()}
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
      {mode === 'menu' ? (
        <>
          <strong>{displaySpeakerName(state.sourceSpeaker, speakerNames)}</strong>
          <button type="button" onClick={() => setMode('rename')}>
            <span aria-hidden="true">✎</span>
            Rename
          </button>
          {onEdit !== undefined && state.turnIndex !== undefined ? (
            <button
              type="button"
              onClick={() => {
                setText(editText ?? '');
                setMode('edit');
              }}
            >
              <span aria-hidden="true">✎</span>
              Edit
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setMode('merge')}
            disabled={mergeTargets.length === 0}
          >
            <span aria-hidden="true">⇄</span>
            Merge
          </button>
        </>
      ) : null}

      {mode === 'rename' ? (
        <>
          <strong>
            Rename {displaySpeakerName(state.sourceSpeaker, speakerNames)}
          </strong>
          <span>Assign speaker name</span>
          <input
            type="text"
            value={speakerName}
            onChange={(event) => setSpeakerName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void handleRename();
              }
            }}
            disabled={saving}
            autoFocus
          />
          <button
            type="button"
            onClick={() => void handleRename()}
            disabled={saving || speakerName.trim().length === 0}
          >
            <span aria-hidden="true">✓</span>
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button type="button" onClick={() => setMode('menu')} disabled={saving}>
            <span aria-hidden="true">←</span>
            Back
          </button>
        </>
      ) : null}

      {mode === 'merge' ? (
        <>
          <strong>
            Merge {displaySpeakerName(state.sourceSpeaker, speakerNames)}
          </strong>
          <span>Into speaker</span>
          <select
            value={targetSpeaker}
            onChange={(event) => setTargetSpeaker(event.target.value)}
            disabled={saving}
          >
            {mergeTargets.map((speaker) => (
              <option key={speaker} value={speaker}>
                {displaySpeakerName(speaker, speakerNames)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleMerge()}
            disabled={saving || targetSpeaker.length === 0}
          >
            <span aria-hidden="true">⇄</span>
            {saving ? 'Merging...' : 'Merge'}
          </button>
          <button type="button" onClick={() => setMode('menu')} disabled={saving}>
            <span aria-hidden="true">←</span>
            Back
          </button>
        </>
      ) : null}

      <button type="button" onClick={onClose} disabled={saving}>
        <span aria-hidden="true">×</span>
        Cancel
      </button>
    </div>
  );
}

export function openSpeakerContextMenu(
  event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
  sourceSpeaker: string,
  setSpeakerMenu: Dispatch<SetStateAction<SpeakerContextMenuState | null>>,
  turnIndex?: number,
): void {
  event.preventDefault();
  event.stopPropagation();

  if ('clientX' in event && event.clientX !== 0 && event.clientY !== 0) {
    setSpeakerMenu({ sourceSpeaker, turnIndex, x: event.clientX, y: event.clientY });
    return;
  }

  const rect = event.currentTarget.getBoundingClientRect();
  setSpeakerMenu({
    sourceSpeaker,
    turnIndex,
    x: rect.left + 16,
    y: rect.top + 16,
  });
}

interface WordAssignmentPopoverProps {
  state: WordAssignmentPopoverState;
  turns: SpeakerWordTurn[];
  speakerNames: Record<string, string>;
  speakers: string[];
  onAssign: (direction: 'previous' | 'next') => Promise<void>;
  onAssignRange: (
    range: 'through-word' | 'from-word',
    speaker: string,
  ) => Promise<void>;
  onClose: () => void;
}

export function WordAssignmentPopover({
  state,
  turns,
  speakerNames,
  speakers,
  onAssign,
  onAssignRange,
  onClose,
}: WordAssignmentPopoverProps) {
  const [saving, setSaving] = useState(false);
  const [rangeMode, setRangeMode] = useState<'through-word' | 'from-word' | null>(
    null,
  );
  const [selectedSpeaker, setSelectedSpeaker] = useState(speakers[0] ?? '');
  const previousTurn = turns[state.turnIndex - 1];
  const nextTurn = turns[state.turnIndex + 1];
  const hasPrevious = previousTurn !== undefined;
  const hasNext = nextTurn !== undefined;
  const newSpeaker = getNextSpeakerName(speakers);

  useEffect(() => {
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
  }, [onClose]);

  async function handleAssign(direction: 'previous' | 'next'): Promise<void> {
    setSaving(true);
    try {
      await onAssign(direction);
    } finally {
      setSaving(false);
    }
  }

  async function handleAssignRange(): Promise<void> {
    if (rangeMode === null || selectedSpeaker.length === 0) {
      return;
    }

    setSaving(true);
    try {
      await onAssignRange(rangeMode, selectedSpeaker);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={styles.speakerMergePopover}
      style={{ left: state.x, top: state.y }}
      onClick={(event) => event.stopPropagation()}
    >
      {rangeMode === null ? (
        <>
          <strong>Assign word</strong>
          <button
            type="button"
            onClick={() => void handleAssign('previous')}
            disabled={saving || !hasPrevious}
          >
            Assign to previous speaker
          </button>
          <button
            type="button"
            onClick={() => void handleAssign('next')}
            disabled={saving || !hasNext}
          >
            Assign to next speaker
          </button>
          <button
            type="button"
            onClick={() => setRangeMode('through-word')}
            disabled={saving || speakers.length === 0}
          >
            Assign till here to speaker
          </button>
          <button
            type="button"
            onClick={() => setRangeMode('from-word')}
            disabled={saving || speakers.length === 0}
          >
            Assign from here to speaker
          </button>
        </>
      ) : null}

      {rangeMode !== null ? (
        <>
          <strong>
            {rangeMode === 'through-word'
              ? 'Assign till here'
              : 'Assign from here'}
          </strong>
          <span>Speaker</span>
          <select
            value={selectedSpeaker}
            onChange={(event) => setSelectedSpeaker(event.target.value)}
            disabled={saving}
          >
            {speakers.map((speaker) => (
              <option key={speaker} value={speaker}>
                {displaySpeakerName(speaker, speakerNames)}
              </option>
            ))}
            <option value={newSpeaker}>New speaker ({newSpeaker})</option>
          </select>
          <button
            type="button"
            onClick={() => void handleAssignRange()}
            disabled={saving || selectedSpeaker.length === 0}
          >
            {saving ? 'Saving...' : 'Assign'}
          </button>
          <button
            type="button"
            onClick={() => setRangeMode(null)}
            disabled={saving}
          >
            Back
          </button>
        </>
      ) : null}
      <button type="button" onClick={onClose} disabled={saving}>
        Cancel
      </button>
    </div>
  );
}

export function openWordAssignmentPopover(
  event: MouseEvent<HTMLElement>,
  turnIndex: number,
  wordIndex: number,
  wordTimestampInMs: number,
  setWordAssignmentPopover: Dispatch<
    SetStateAction<WordAssignmentPopoverState | null>
  >,
): void {
  event.preventDefault();
  event.stopPropagation();
  setWordAssignmentPopover({
    turnIndex,
    wordIndex,
    wordTimestampInMs,
    x: event.clientX,
    y: event.clientY,
  });
}

interface DerivationTabProps<T> {
  meetingId: string;
  kind: MeetingDerivationKind;
  present: boolean;
  revision: number;
  loadDerivation: <U>(
    meetingId: string,
    kind: MeetingDerivationKind,
  ) => Promise<U | null>;
  render: (
    data: T,
    setData: Dispatch<SetStateAction<T | null>>,
  ) => ReactElement;
}

export function DerivationTab<T>({
  meetingId,
  kind,
  present,
  revision,
  loadDerivation,
  render,
}: DerivationTabProps<T>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!present) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    loadDerivation<T>(meetingId, kind)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [meetingId, kind, present, revision, loadDerivation]);

  if (!present) {
    return (
      <p className={styles.empty}>
        Not generated yet. Use the button above to run it.
      </p>
    );
  }

  if (loading) {
    return <p className={styles.empty}>Loading...</p>;
  }

  if (error !== null) {
    return <p className={styles.empty}>Failed to load: {error}</p>;
  }

  if (data === null) {
    return <p className={styles.empty}>No data.</p>;
  }

  return render(data, setData);
}
