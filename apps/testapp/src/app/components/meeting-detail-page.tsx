import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type RefObject,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type SetStateAction,
} from 'react';
import type { SpeakerTurn, Transcript } from '@notetaker/engine';
import type {
  MeetingArtifactKind,
  StoredMeetingSummary,
} from '@notetaker/filesystem';
import styles from '../app.module.css';
import { ExportControls } from './export-controls';

type RecorderStatus = 'idle' | 'ready' | 'recording' | 'saving' | 'error';
type EngineStatus = 'idle' | 'processing' | 'error';
type MediaElementRef = { current: HTMLMediaElement | null };

interface TimestampedWord {
  word: string;
  timestampInMs: number;
}

interface SpeakerWordTurn {
  speaker: string;
  startSeconds: number;
  endSeconds: number;
  words: TimestampedWord[];
  wordCount: number;
}

interface SpeakerContextMenuState {
  sourceSpeaker: string;
  turnIndex?: number;
  x: number;
  y: number;
}

type SpeakerContextMenuMode = 'menu' | 'rename' | 'merge' | 'edit';

interface LiveTranscriptSegment {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

interface WordAssignmentPopoverState {
  turnIndex: number;
  wordIndex: number;
  wordTimestampInMs: number;
  x: number;
  y: number;
}

interface TranscriptSegmentMenuState {
  segmentIndex: number;
  x: number;
  y: number;
}

type TabKey =
  | 'details'
  | 'recording'
  | 'transcript'
  | 'diarization'
  | 'word-sync'
  | 'speaker-names';

const TAB_LABELS: Record<TabKey, string> = {
  details: 'Details',
  recording: 'Recording',
  transcript: 'Transcript',
  diarization: 'Diarization',
  'word-sync': 'Word sync',
  'speaker-names': 'Speaker names',
};

const TABS: TabKey[] = [
  'details',
  'recording',
  'transcript',
  'diarization',
  'word-sync',
  'speaker-names',
];

interface MeetingDetailPageProps {
  meeting: StoredMeetingSummary;
  meetingUrl: string | undefined;
  isRecording: boolean;
  status: RecorderStatus;
  engineStatus: EngineStatus;
  engineMessage: string;
  artifactRevision: number;
  liveTranscriptSegments: LiveTranscriptSegment[];
  loadArtifact: <T>(
    meetingId: string,
    kind: MeetingArtifactKind,
  ) => Promise<T | null>;
  saveArtifact: <T>(
    meetingId: string,
    kind: MeetingArtifactKind,
    data: T,
  ) => Promise<void>;
  deleteArtifact: (
    meetingId: string,
    kind: MeetingArtifactKind,
  ) => Promise<void>;
  onUpdateMeeting: (
    id: string,
    patch: Partial<{ name: string; date: string; participantCount: number }>,
  ) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCancelRecording: () => void;
  onUploadRecording: (file: File) => void;
  onDeleteMeeting: () => void;
  onRunTranscript: () => void;
  onRunDiarization: () => void;
  onRunWordSync: () => void;
  onRunSpeakerNaming: () => void;
  onOpenLogging: (mode: 'engine' | 'transcription') => void;
  onBack: () => void;
  formatBytes: (size: number) => string;
  formatDate: (timestamp: number) => string;
  formatTimestamp: (seconds: number) => string;
}

export function MeetingDetailPage({
  meeting,
  meetingUrl,
  isRecording,
  status,
  engineStatus,
  engineMessage,
  artifactRevision,
  liveTranscriptSegments,
  loadArtifact,
  saveArtifact,
  deleteArtifact,
  onUpdateMeeting,
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  onUploadRecording,
  onDeleteMeeting,
  onRunTranscript,
  onRunDiarization,
  onRunWordSync,
  onRunSpeakerNaming,
  onOpenLogging,
  onBack,
  formatBytes,
  formatDate,
  formatTimestamp,
}: MeetingDetailPageProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('details');
  const [speakerNamesSaved, setSpeakerNamesSaved] = useState(
    meeting.artifacts['speaker-names'],
  );
  const [loggingAvailableTab, setLoggingAvailableTab] = useState<TabKey | null>(
    null,
  );
  const recordingAudioRef = useRef<HTMLMediaElement | null>(null);
  const diarizationAudioRef = useRef<HTMLMediaElement | null>(null);
  const transcriptAudioRef = useRef<HTMLMediaElement | null>(null);
  const wordSyncAudioRef = useRef<HTMLMediaElement | null>(null);

  useEffect(() => {
    setSpeakerNamesSaved(meeting.artifacts['speaker-names']);
  }, [meeting.id, meeting.artifacts]);

  useEffect(() => {
    setLoggingAvailableTab(null);
  }, [meeting.id]);

  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key !== ' ' || isEditableTarget(event.target)) {
        return;
      }

      const mediaRef = getActiveMediaRef(activeTab, {
        recording: recordingAudioRef,
        transcript: transcriptAudioRef,
        diarization: diarizationAudioRef,
        wordSync: wordSyncAudioRef,
      });

      if (mediaRef === null || mediaRef.current === null) {
        return;
      }

      event.preventDefault();
      void toggleRecordingPlayback(mediaRef.current);
    }

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeTab]);

  const hasRecording = meeting.recordingFileName !== null;
  const hasTranscript = meeting.artifacts.transcript;
  const hasDiarization = meeting.artifacts.diarization;
  const hasWordSync = meeting.artifacts['word-sync'];
  const processing = engineStatus === 'processing';

  return (
    <section className={styles.panel}>
      <div className={styles.detailHeader}>
        <h2>{meeting.name}</h2>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </div>

      <nav className={styles.tabs} aria-label="Meeting sections">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            data-active={activeTab === tab}
            data-status={getTabStatus(tab, meeting, speakerNamesSaved)}
            onClick={() => {
              setActiveTab(tab);
              setLoggingAvailableTab(null);
            }}
          >
            <span>{TAB_LABELS[tab]}</span>
          </button>
        ))}
      </nav>

      {activeTab === 'details' ? (
        <DetailsTab
          meeting={meeting}
          status={status}
          isRecording={isRecording}
          onUpdateMeeting={onUpdateMeeting}
          onDeleteMeeting={onDeleteMeeting}
          formatDate={formatDate}
        />
      ) : null}

      {activeTab === 'recording' ? (
        <RecordingTab
          meeting={meeting}
          meetingUrl={meetingUrl}
          audioRef={recordingAudioRef}
          isRecording={isRecording}
          status={status}
          onStartRecording={onStartRecording}
          onStopRecording={onStopRecording}
          onCancelRecording={onCancelRecording}
          onUploadRecording={onUploadRecording}
          formatBytes={formatBytes}
        />
      ) : null}

      {activeTab === 'transcript' ? (
        <>
          <ArtifactToolbar
            label="Generate transcript"
            running={processing}
            disabled={!hasRecording || processing}
            disabledReason={hasRecording ? null : 'Add a recording first.'}
            engineMessage={engineMessage}
            onRun={() => {
              setLoggingAvailableTab('transcript');
              onRunTranscript();
            }}
            onOpenLogging={() => onOpenLogging('transcription')}
            showLogging={loggingAvailableTab === 'transcript'}
          />
          {processing && liveTranscriptSegments.length > 0 ? (
            <LiveTranscriptPreview
              segments={liveTranscriptSegments}
              formatTimestamp={formatTimestamp}
            />
          ) : processing ? (
            <p className={styles.empty}>Waiting for speech...</p>
          ) : (
            <ArtifactTab<Transcript>
              meetingId={meeting.id}
              kind="transcript"
              present={meeting.artifacts.transcript}
              revision={artifactRevision}
              loadArtifact={loadArtifact}
              render={(transcript, setTranscript) => (
                <TranscriptArtifactView
                  meetingId={meeting.id}
                  meetingName={meeting.name}
                  meetingUrl={meetingUrl}
                  audioRef={transcriptAudioRef}
                  recordingMimeType={meeting.recordingMimeType}
                  transcript={transcript}
                  setTranscript={setTranscript}
                  saveArtifact={saveArtifact}
                  deleteArtifact={deleteArtifact}
                  formatTimestamp={formatTimestamp}
                />
              )}
            />
          )}
        </>
      ) : null}

      {activeTab === 'diarization' ? (
        <>
          <ArtifactToolbar
            label="Generate diarization"
            running={processing}
            disabled={!hasRecording || processing}
            disabledReason={hasRecording ? null : 'Add a recording first.'}
            engineMessage={engineMessage}
            onRun={() => {
              setLoggingAvailableTab('diarization');
              onRunDiarization();
            }}
            onOpenLogging={() => onOpenLogging('engine')}
            showLogging={loggingAvailableTab === 'diarization'}
          />
          <ArtifactTab<SpeakerTurn[]>
            meetingId={meeting.id}
            kind="diarization"
            present={meeting.artifacts.diarization}
            revision={artifactRevision}
            loadArtifact={loadArtifact}
            render={(turns, setTurns) => (
              <DiarizationArtifactView
                meetingId={meeting.id}
                meetingName={meeting.name}
                meetingUrl={meetingUrl}
                audioRef={diarizationAudioRef}
                recordingMimeType={meeting.recordingMimeType}
                turns={turns}
                setTurns={setTurns}
                loadArtifact={loadArtifact}
                saveArtifact={saveArtifact}
                onSpeakerNamesSaved={() => setSpeakerNamesSaved(true)}
                formatTimestamp={formatTimestamp}
              />
            )}
          />
        </>
      ) : null}

      {activeTab === 'word-sync' ? (
        <>
          <ArtifactToolbar
            label="Generate word sync"
            running={processing}
            disabled={!hasTranscript || !hasDiarization || processing}
            disabledReason={
              !hasTranscript && !hasDiarization
                ? 'Generate transcript and diarization first.'
                : !hasTranscript
                  ? 'Generate transcript first.'
                  : !hasDiarization
                    ? 'Generate diarization first.'
                    : null
            }
            engineMessage={engineMessage}
            onRun={() => {
              setLoggingAvailableTab('word-sync');
              onRunWordSync();
            }}
            onOpenLogging={() => onOpenLogging('engine')}
            showLogging={loggingAvailableTab === 'word-sync'}
          />
          <WordSyncArtifactTab
            meetingId={meeting.id}
            meetingName={meeting.name}
            meetingUrl={meetingUrl}
            audioRef={wordSyncAudioRef}
            recordingMimeType={meeting.recordingMimeType}
            present={meeting.artifacts['word-sync']}
            revision={artifactRevision}
            loadArtifact={loadArtifact}
            saveArtifact={saveArtifact}
            onSpeakerNamesSaved={() => setSpeakerNamesSaved(true)}
            formatTimestamp={formatTimestamp}
          />
        </>
      ) : null}

      {activeTab === 'speaker-names' ? (
        <>
          <ArtifactToolbar
            label="Automatic lookup"
            running={processing}
            disabled={!hasWordSync || processing}
            disabledReason={
              hasWordSync
                ? null
                : 'Generate word sync first for automatic lookup.'
            }
            engineMessage={engineMessage}
            onRun={() => {
              setLoggingAvailableTab('speaker-names');
              onRunSpeakerNaming();
            }}
            onOpenLogging={() => onOpenLogging('engine')}
            showLogging={loggingAvailableTab === 'speaker-names'}
          />
          <SpeakerNamesTab
            meetingId={meeting.id}
            meetingName={meeting.name}
            present={meeting.artifacts.diarization}
            revision={artifactRevision}
            loadArtifact={loadArtifact}
            saveArtifact={saveArtifact}
            onSaved={() => setSpeakerNamesSaved(true)}
          />
        </>
      ) : null}
    </section>
  );
}

function getTabStatus(
  tab: TabKey,
  meeting: StoredMeetingSummary,
  speakerNamesSaved: boolean,
): string {
  if (tab === 'details') {
    return 'completed';
  }

  if (tab === 'recording') {
    return meeting.recordingFileName !== null ? 'completed' : 'pending';
  }

  if (tab === 'speaker-names') {
    return speakerNamesSaved ? 'completed' : 'pending';
  }

  return meeting.artifacts[tab] ? 'completed' : 'pending';
}

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

function ArtifactToolbar({
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

interface DetailsTabProps {
  meeting: StoredMeetingSummary;
  status: RecorderStatus;
  isRecording: boolean;
  onUpdateMeeting: (
    id: string,
    patch: Partial<{ name: string; date: string; participantCount: number }>,
  ) => void;
  onDeleteMeeting: () => void;
  formatDate: (timestamp: number) => string;
}

function DetailsTab({
  meeting,
  status,
  isRecording,
  onUpdateMeeting,
  onDeleteMeeting,
  formatDate,
}: DetailsTabProps) {
  const [name, setName] = useState(meeting.name);
  const [date, setDate] = useState(meeting.date);
  const [participantCount, setParticipantCount] = useState(
    meeting.participantCount,
  );

  useEffect(() => {
    setName(meeting.name);
    setDate(meeting.date);
    setParticipantCount(meeting.participantCount);
  }, [meeting.id, meeting.name, meeting.date, meeting.participantCount]);

  const editingDisabled = isRecording || status === 'saving';

  function commitName(): void {
    const trimmed = name.trim();
    if (trimmed.length > 0 && trimmed !== meeting.name) {
      onUpdateMeeting(meeting.id, { name: trimmed });
    } else {
      setName(meeting.name);
    }
  }

  function commitDate(): void {
    if (date.length > 0 && date !== meeting.date) {
      onUpdateMeeting(meeting.id, { date });
    } else {
      setDate(meeting.date);
    }
  }

  function commitParticipants(): void {
    const safe = Math.max(1, participantCount);
    if (safe !== meeting.participantCount) {
      onUpdateMeeting(meeting.id, { participantCount: safe });
    } else {
      setParticipantCount(meeting.participantCount);
    }
  }

  return (
    <>
      <div className={styles.engineModelGrid}>
        <label className={styles.engineModelPicker}>
          <span>Name</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            disabled={editingDisabled}
          />
        </label>
        <label className={styles.engineModelPicker}>
          <span>Date</span>
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            onBlur={commitDate}
            disabled={editingDisabled}
          />
        </label>
        <label className={styles.engineModelPicker}>
          <span>Participants</span>
          <input
            type="number"
            min={1}
            max={50}
            value={participantCount}
            onChange={(event) =>
              setParticipantCount(
                Math.max(1, Number.parseInt(event.target.value, 10) || 1),
              )
            }
            onBlur={commitParticipants}
            disabled={editingDisabled}
          />
        </label>
      </div>

      <p className={styles.message}>Created {formatDate(meeting.createdAt)}</p>

      <div className={styles.actions}>
        <button
          type="button"
          onClick={onDeleteMeeting}
          disabled={isRecording || status === 'saving'}
        >
          Delete meeting
        </button>
      </div>
    </>
  );
}

interface RecordingTabProps {
  meeting: StoredMeetingSummary;
  meetingUrl: string | undefined;
  audioRef: MediaElementRef;
  isRecording: boolean;
  status: RecorderStatus;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCancelRecording: () => void;
  onUploadRecording: (file: File) => void;
  formatBytes: (size: number) => string;
}

function RecordingTab({
  meeting,
  meetingUrl,
  audioRef,
  isRecording,
  status,
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  onUploadRecording,
  formatBytes,
}: RecordingTabProps) {
  const hasRecording = meeting.recordingFileName !== null;

  function handleUpload(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.currentTarget.value = '';

    if (file !== undefined) {
      onUploadRecording(file);
    }
  }

  return (
    <>
      {hasRecording && meetingUrl !== undefined ? (
        <div className={styles.recordingPlayback}>
          <RecordingMedia
            mediaRef={audioRef}
            meetingUrl={meetingUrl}
            mimeType={meeting.recordingMimeType}
          />
        </div>
      ) : (
        <p className={styles.empty}>No recording attached yet.</p>
      )}

      {hasRecording && meeting.recordingSize !== null ? (
        <p className={styles.message}>
          {formatBytes(meeting.recordingSize)}
          {meeting.recordingMimeType !== null
            ? ` | ${meeting.recordingMimeType}`
            : ''}
        </p>
      ) : null}

      <div className={styles.actions}>
        {isRecording ? (
          <>
            <button type="button" onClick={onStopRecording}>
              Stop & Save
            </button>
            <button type="button" onClick={onCancelRecording}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onStartRecording}
              disabled={status === 'saving'}
            >
              {hasRecording ? 'Re-record' : 'Start Recording'}
            </button>
            <label className={styles.uploadInline}>
              <span>
                {hasRecording ? 'Replace via upload' : 'Upload audio/video'}
              </span>
              <input
                type="file"
                accept="audio/*,video/*,.mp3,.m4a,.wav,.webm,.ogg,.mp4,.mov,.m4v"
                onChange={handleUpload}
                disabled={status === 'saving'}
              />
            </label>
          </>
        )}
      </div>
    </>
  );
}

interface RecordingPlaybackProps {
  audioRef: MediaElementRef;
  meetingUrl: string | undefined;
  mimeType: string | null;
}

function RecordingPlayback({
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

function RecordingMedia({
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

function isVideoMimeType(mimeType: string | null): boolean {
  return mimeType?.startsWith('video/') ?? false;
}

interface TranscriptArtifactViewProps {
  meetingId: string;
  meetingName: string;
  meetingUrl: string | undefined;
  audioRef: MediaElementRef;
  recordingMimeType: string | null;
  transcript: Transcript;
  setTranscript: Dispatch<SetStateAction<Transcript | null>>;
  saveArtifact: <U>(
    meetingId: string,
    kind: MeetingArtifactKind,
    data: U,
  ) => Promise<void>;
  deleteArtifact: (
    meetingId: string,
    kind: MeetingArtifactKind,
  ) => Promise<void>;
  formatTimestamp: (seconds: number) => string;
}

function TranscriptArtifactView({
  meetingId,
  meetingName,
  meetingUrl,
  audioRef,
  recordingMimeType,
  transcript,
  setTranscript,
  saveArtifact,
  deleteArtifact,
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

    await saveArtifact(meetingId, 'transcript', nextTranscript);
    await deleteArtifact(meetingId, 'word-sync');
    await deleteArtifact(meetingId, 'speaker-names');
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
  formatTimestamp: (seconds: number) => string;
}

function LiveTranscriptPreview({
  segments,
  formatTimestamp,
}: LiveTranscriptPreviewProps) {
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
            <strong>[{formatTimestamp(segment.startSeconds)}]</strong>
            <span>{segment.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

async function playRecordingFrom(
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

async function toggleRecordingPlayback(media: HTMLMediaElement): Promise<void> {
  if (media.paused) {
    await media.play();
    return;
  }

  media.pause();
}

function getActiveMediaRef(
  activeTab: TabKey,
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

function isEditableTarget(target: EventTarget | null): boolean {
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

function DiarizationArtifactView({
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

interface WordSyncArtifactTabProps {
  meetingId: string;
  meetingName: string;
  meetingUrl: string | undefined;
  audioRef: MediaElementRef;
  recordingMimeType: string | null;
  present: boolean;
  revision: number;
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

function WordSyncArtifactTab({
  meetingId,
  meetingName,
  meetingUrl,
  audioRef,
  recordingMimeType,
  present,
  revision,
  loadArtifact,
  saveArtifact,
  onSpeakerNamesSaved,
  formatTimestamp,
}: WordSyncArtifactTabProps) {
  const [words, setWords] = useState<TimestampedWord[] | null>(null);
  const [diarization, setDiarization] = useState<SpeakerTurn[] | null>(null);
  const [turns, setTurns] = useState<SpeakerWordTurn[] | null>(null);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [speakerMenu, setSpeakerMenu] =
    useState<SpeakerContextMenuState | null>(null);
  const [wordAssignmentPopover, setWordAssignmentPopover] =
    useState<WordAssignmentPopoverState | null>(null);
  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  const [wordCount, setWordCount] = useState(0);
  const [currentPlaybackTime, setCurrentPlaybackTime] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeWordTimestampInMs =
    words !== null ? getActiveWordTimestampInMs(words, currentPlaybackTime) : null;

  useEffect(() => {
    const media = audioRef.current;

    if (media === null) {
      return;
    }

    const mediaElement = media;

    function handleTimeUpdate(): void {
      setCurrentPlaybackTime(mediaElement.currentTime);
    }

    function handleSeeked(): void {
      setCurrentPlaybackTime(mediaElement.currentTime);
    }

    handleTimeUpdate();
    mediaElement.addEventListener('timeupdate', handleTimeUpdate);
    mediaElement.addEventListener('seeked', handleSeeked);

    return () => {
      mediaElement.removeEventListener('timeupdate', handleTimeUpdate);
      mediaElement.removeEventListener('seeked', handleSeeked);
    };
  }, [audioRef, loading, meetingUrl, present, turns]);

  useEffect(() => {
    activeWordRef.current?.scrollIntoView({
      block: 'center',
      behavior: 'smooth',
    });
  }, [activeWordTimestampInMs]);

  useEffect(() => {
    let cancelled = false;

    if (!present) {
      setWords(null);
      setDiarization(null);
      setTurns(null);
      setWordCount(0);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    Promise.all([
      loadArtifact<TimestampedWord[]>(meetingId, 'word-sync'),
      loadArtifact<SpeakerTurn[]>(meetingId, 'diarization'),
      loadArtifact<Record<string, string>>(meetingId, 'speaker-names'),
    ])
      .then(([words, diarization, speakerNames]) => {
        if (cancelled) {
          return;
        }

        if (words === null || diarization === null) {
          throw new Error('Word sync or diarization artifact missing.');
        }

        setWords(words);
        setDiarization(diarization);
        setTurns(buildSpeakerWordTurns(words, diarization));
        setSpeakerNames(speakerNames ?? {});
        setWordCount(words.length);
        setLoading(false);
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
  }, [meetingId, present, revision, loadArtifact]);

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

  if (turns === null) {
    return <p className={styles.empty}>No data.</p>;
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
          {[...new Set(turns.map((turn) => turn.speaker))].length} speaker
          {[...new Set(turns.map((turn) => turn.speaker))].length === 1
            ? ''
            : 's'}
          , {turns.length} turn{turns.length === 1 ? '' : 's'}, {wordCount} word
          {wordCount === 1 ? '' : 's'}
        </h3>
        <ExportControls
          json={words ?? []}
          jsonFileName={`${meetingName}-word-sync.json`}
          text={formatSpeakerWordTurnsText(turns, speakerNames)}
          textFileName={`${meetingName}-word-sync.txt`}
        />
        {diarization !== null && words !== null ? (
          <button
            type="button"
            onClick={async () => {
              const alignedDiarization = alignDiarizationToSentences(
                diarization,
                words,
              );

              await saveArtifact(meetingId, 'diarization', alignedDiarization);
              setDiarization(alignedDiarization);
              setTurns(buildSpeakerWordTurns(words, alignedDiarization));
            }}
          >
            Align sentences
          </button>
        ) : null}
      </div>
      {diarization !== null && words !== null ? (
        speakerMenu !== null ? (
          <SpeakerContextMenu
            speakers={collectSpeakers(diarization)}
            speakerNames={speakerNames}
            state={speakerMenu}
            editText={
              speakerMenu.turnIndex !== undefined
                ? turns[speakerMenu.turnIndex]?.words
                    .map((word) => word.word)
                    .join(' ')
                : undefined
            }
            onClose={() => setSpeakerMenu(null)}
            onRename={async (speaker, name) => {
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
            }}
            onMerge={async (sourceSpeaker, targetSpeaker) => {
              const mergedDiarization = mergeSpeakerTurns(
                diarization,
                sourceSpeaker,
                targetSpeaker,
              );

              await saveArtifact(meetingId, 'diarization', mergedDiarization);
              setDiarization(mergedDiarization);
              setTurns(buildSpeakerWordTurns(words, mergedDiarization));
              setSpeakerMenu(null);
            }}
            onEdit={async (turnIndex, text) => {
              const turn = turns[turnIndex];

              if (turn === undefined) {
                return;
              }

              const nextWords = replaceWordSyncTurnWords(words, turn, text);
              const transcript = await loadArtifact<Transcript>(
                meetingId,
                'transcript',
              );

              await saveArtifact(meetingId, 'word-sync', nextWords);
              if (transcript !== null) {
                await saveArtifact(
                  meetingId,
                  'transcript',
                  replaceTranscriptTextForTimeRange(transcript, turn, text),
                );
              }
              setWords(nextWords);
              setTurns(buildSpeakerWordTurns(nextWords, diarization));
              setWordCount(nextWords.length);
              setSpeakerMenu(null);
            }}
          />
        ) : null
      ) : null}
      {diarization !== null &&
      words !== null &&
      wordAssignmentPopover !== null ? (
        <WordAssignmentPopover
          state={wordAssignmentPopover}
          turns={turns}
          speakerNames={speakerNames}
          speakers={collectSpeakers(diarization)}
          onClose={() => setWordAssignmentPopover(null)}
          onAssign={async (direction) => {
            const adjustedDiarization = assignWordToAdjacentSpeaker(
              diarization,
              turns,
              wordAssignmentPopover,
              direction,
            );

            await saveArtifact(meetingId, 'diarization', adjustedDiarization);
            setDiarization(adjustedDiarization);
            setTurns(buildSpeakerWordTurns(words, adjustedDiarization));
            setWordAssignmentPopover(null);
          }}
          onAssignRange={async (range, speaker) => {
            const adjustedDiarization = assignWordRangeToSpeaker(
              diarization,
              turns,
              wordAssignmentPopover,
              range,
              speaker,
            );

            await saveArtifact(meetingId, 'diarization', adjustedDiarization);
            setDiarization(adjustedDiarization);
            setTurns(buildSpeakerWordTurns(words, adjustedDiarization));
            setWordAssignmentPopover(null);
          }}
        />
      ) : null}
      {turns.length === 0 ? (
        <p>No synced words matched the diarization turns.</p>
      ) : (
        <ul>
          {turns.map((turn, index) => (
            <li
              key={`${turn.startSeconds}-${index}`}
              className={styles.playbackSegment}
              tabIndex={0}
            onContextMenu={(event) =>
                openSpeakerContextMenu(event, turn.speaker, setSpeakerMenu, index)
              }
              onKeyDown={(event) => {
                if (
                  event.key === 'ContextMenu' ||
                  (event.shiftKey && event.key === 'F10')
                ) {
                  openSpeakerContextMenu(event, turn.speaker, setSpeakerMenu, index);
                }
              }}
            >
              <div>
                <strong>{displaySpeakerName(turn.speaker, speakerNames)}</strong>
                <span>
                  {formatTimestamp(turn.startSeconds)} to{' '}
                  {formatTimestamp(turn.endSeconds)} ({turn.wordCount} word
                  {turn.wordCount === 1 ? '' : 's'})
                </span>
                <span className={styles.wordSyncText}>
                  {turn.words.map((word, wordIndex) => (
                    <WordSyncWord
                      key={`${word.timestampInMs}-${wordIndex}`}
                      word={word}
                      wordIndex={wordIndex}
                      turnIndex={index}
                      active={word.timestampInMs === activeWordTimestampInMs}
                      activeWordRef={activeWordRef}
                      audioRef={audioRef}
                      setWordAssignmentPopover={setWordAssignmentPopover}
                      formatTimestamp={formatTimestamp}
                    />
                  ))}
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
      )}
    </div>
  );
}

function buildSpeakerWordTurns(
  words: TimestampedWord[],
  turns: SpeakerTurn[],
): SpeakerWordTurn[] {
  return turns
    .map((turn) => {
      const turnWords = words.filter((word) => {
        const wordSeconds = word.timestampInMs / 1000;

        return (
          wordSeconds >= turn.startSeconds && wordSeconds < turn.endSeconds
        );
      });

      return {
        speaker: turn.speaker,
        startSeconds: turn.startSeconds,
        endSeconds: turn.endSeconds,
        words: turnWords,
        wordCount: turnWords.length,
      };
    })
    .filter((turn) => turn.wordCount > 0);
}

interface WordSyncWordProps {
  word: TimestampedWord;
  wordIndex: number;
  turnIndex: number;
  active: boolean;
  activeWordRef: RefObject<HTMLSpanElement | null>;
  audioRef: MediaElementRef;
  setWordAssignmentPopover: Dispatch<
    SetStateAction<WordAssignmentPopoverState | null>
  >;
  formatTimestamp: (seconds: number) => string;
}

function WordSyncWord({
  word,
  wordIndex,
  turnIndex,
  active,
  activeWordRef,
  audioRef,
  setWordAssignmentPopover,
  formatTimestamp,
}: WordSyncWordProps) {
  return (
    <span
      ref={active ? activeWordRef : undefined}
      className={styles.wordSyncWord}
      data-active={active}
      data-timecode={formatTimestamp(word.timestampInMs / 1000)}
      onClick={(event) => {
        event.stopPropagation();
        void playRecordingFrom(audioRef, word.timestampInMs / 1000 - 5);
      }}
      onContextMenu={(event) =>
        openWordAssignmentPopover(
          event,
          turnIndex,
          wordIndex,
          word.timestampInMs,
          setWordAssignmentPopover,
        )
      }
    >
      {word.word}
    </span>
  );
}

function getActiveWordTimestampInMs(
  words: TimestampedWord[],
  currentPlaybackTime: number,
): number | null {
  const currentTimeInMs = currentPlaybackTime * 1000;
  let activeWord: TimestampedWord | null = null;

  for (const word of [...words].sort(
    (first, second) => first.timestampInMs - second.timestampInMs,
  )) {
    if (word.timestampInMs > currentTimeInMs) {
      break;
    }

    activeWord = word;
  }

  return activeWord?.timestampInMs ?? null;
}

function replaceWordSyncTurnWords(
  words: TimestampedWord[],
  turn: SpeakerWordTurn,
  text: string,
): TimestampedWord[] {
  const nextWords = text.trim().split(/\s+/).filter(Boolean);
  const unchangedWords = words.filter((word) => {
    const wordSeconds = word.timestampInMs / 1000;

    return wordSeconds < turn.startSeconds || wordSeconds >= turn.endSeconds;
  });
  const replacementWords = nextWords.map((word, index) => ({
    word,
    timestampInMs:
      turn.words[index]?.timestampInMs ??
      interpolateWordTimestampInMs(turn, index, nextWords.length),
  }));

  return [...unchangedWords, ...replacementWords].sort(
    (first, second) => first.timestampInMs - second.timestampInMs,
  );
}

function interpolateWordTimestampInMs(
  turn: SpeakerWordTurn,
  index: number,
  wordCount: number,
): number {
  const startInMs = Math.round(turn.startSeconds * 1000);
  const durationInMs = Math.max(
    1,
    Math.round((turn.endSeconds - turn.startSeconds) * 1000),
  );

  return startInMs + Math.round((durationInMs * (index + 1)) / (wordCount + 1));
}

function replaceTranscriptTextForTimeRange(
  transcript: Transcript,
  turn: SpeakerWordTurn,
  text: string,
): Transcript {
  const overlappingSegments = transcript.segments.filter((segment) =>
    rangesOverlap(
      segment.startSeconds,
      segment.endSeconds,
      turn.startSeconds,
      turn.endSeconds,
    ),
  );

  if (overlappingSegments.length === 0) {
    return transcript;
  }

  const firstSegment = overlappingSegments[0];
  const nextSegments = transcript.segments
    .map((segment) => {
      if (segment === firstSegment) {
        return { ...segment, text };
      }

      if (overlappingSegments.includes(segment)) {
        return { ...segment, text: '' };
      }

      return segment;
    })
    .filter((segment) => segment.text.trim().length > 0);

  return {
    ...transcript,
    text: nextSegments.map((segment) => segment.text).join(' '),
    segments: nextSegments,
  };
}

function rangesOverlap(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
): boolean {
  return firstStart < secondEnd && secondStart < firstEnd;
}

function formatSpeakerWordTurnsText(
  turns: SpeakerWordTurn[],
  speakerNames: Record<string, string>,
): string {
  return turns
    .map(
      (turn) =>
        `${displaySpeakerName(turn.speaker, speakerNames)}: ${turn.words
          .map((word) => word.word)
          .join(' ')}`,
    )
    .join('\n');
}

interface SpeakerNamesTabProps {
  meetingId: string;
  meetingName: string;
  present: boolean;
  revision: number;
  loadArtifact: <U>(
    meetingId: string,
    kind: MeetingArtifactKind,
  ) => Promise<U | null>;
  saveArtifact: <U>(
    meetingId: string,
    kind: MeetingArtifactKind,
    data: U,
  ) => Promise<void>;
  onSaved: () => void;
}

function SpeakerNamesTab({
  meetingId,
  meetingName,
  present,
  revision,
  loadArtifact,
  saveArtifact,
  onSaved,
}: SpeakerNamesTabProps) {
  const [names, setNames] = useState<Record<string, string> | null>(null);
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!present) {
      setNames(null);
      setSpeakers([]);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    Promise.all([
      loadArtifact<SpeakerTurn[]>(meetingId, 'diarization'),
      loadArtifact<Record<string, string>>(meetingId, 'speaker-names'),
    ])
      .then(([diarization, savedNames]) => {
        if (cancelled) {
          return;
        }

        if (diarization === null) {
          throw new Error('Diarization artifact missing.');
        }

        const nextSpeakers = collectSpeakers(diarization);
        const nextNames = Object.fromEntries(
          nextSpeakers.map((speaker) => [
            speaker,
            savedNames?.[speaker] ?? speaker,
          ]),
        );

        setSpeakers(nextSpeakers);
        setNames(nextNames);
        setLoading(false);
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
  }, [meetingId, present, revision, loadArtifact]);

  async function saveNames(nextNames: Record<string, string>): Promise<void> {
    setNames(nextNames);
    await saveArtifact(meetingId, 'speaker-names', nextNames);
    onSaved();
  }

  if (!present) {
    return <p className={styles.empty}>Generate diarization first.</p>;
  }

  if (loading) {
    return <p className={styles.empty}>Loading...</p>;
  }

  if (error !== null) {
    return <p className={styles.empty}>Failed to load: {error}</p>;
  }

  if (names === null) {
    return <p className={styles.empty}>No speaker names.</p>;
  }

  return (
    <div className={styles.transcriptResult}>
      <div className={styles.resultHeader}>
        <h3>
          Speaker names - {speakers.length} speaker
          {speakers.length === 1 ? '' : 's'}
        </h3>
        <ExportControls
          json={names}
          jsonFileName={`${meetingName}-speaker-names.json`}
        />
      </div>
      <ul className={styles.fileList}>
        {speakers.map((speaker) => (
          <li key={speaker} className={styles.speakerNameRow}>
            <label>
              <span>{speaker}</span>
              <input
                type="text"
                value={names[speaker] ?? speaker}
                onChange={(event) =>
                  setNames({ ...names, [speaker]: event.target.value })
                }
                onBlur={(event) => {
                  const trimmed = event.target.value.trim();
                  void saveNames({
                    ...names,
                    [speaker]: trimmed.length > 0 ? trimmed : speaker,
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>
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

  return (
    <div
      className={styles.speakerMergePopover}
      style={{ left: state.x, top: state.y }}
      onClick={(event) => event.stopPropagation()}
    >
      {mode === 'menu' ? (
        <>
          <strong>Transcript segment</strong>
          <button type="button" onClick={() => setMode('edit')}>
            <span aria-hidden="true">✎</span>
            Edit
          </button>
        </>
      ) : null}

      {mode === 'edit' ? (
        <>
          <strong>Edit transcript segment</strong>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                void handleSave();
              }
            }}
            disabled={saving}
            autoFocus
          />
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || text.trim().length === 0}
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

      <button type="button" onClick={onClose} disabled={saving}>
        <span aria-hidden="true">×</span>
        Cancel
      </button>
    </div>
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

function SpeakerContextMenu({
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

      {mode === 'edit' ? (
        <>
          <strong>Edit word sync segment</strong>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                void handleEdit();
              }
            }}
            disabled={saving}
            autoFocus
          />
          <button
            type="button"
            onClick={() => void handleEdit()}
            disabled={saving || text.trim().length === 0}
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

      <button type="button" onClick={onClose} disabled={saving}>
        <span aria-hidden="true">×</span>
        Cancel
      </button>
    </div>
  );
}

function openSpeakerContextMenu(
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

function WordAssignmentPopover({
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

function openWordAssignmentPopover(
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

function collectSpeakers(turns: SpeakerTurn[]): string[] {
  return [...new Set(turns.map((turn) => turn.speaker))].sort();
}

function getNextSpeakerName(speakers: string[]): string {
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

function displaySpeakerName(
  speaker: string,
  speakerNames: Record<string, string>,
): string {
  const name = speakerNames[speaker]?.trim();

  return name !== undefined && name.length > 0 ? name : speaker;
}

function useSpeakerNames(
  meetingId: string,
  speakers: string[],
  loadArtifact: <U>(
    meetingId: string,
    kind: MeetingArtifactKind,
  ) => Promise<U | null>,
): [Record<string, string>, Dispatch<SetStateAction<Record<string, string>>>] {
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const speakerKey = speakers.join('\0');

  useEffect(() => {
    let cancelled = false;

    loadArtifact<Record<string, string>>(meetingId, 'speaker-names').then(
      (savedNames) => {
        if (!cancelled) {
          setSpeakerNames(savedNames ?? {});
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [meetingId, speakerKey, loadArtifact]);

  return [speakerNames, setSpeakerNames];
}

async function saveSpeakerNameArtifact(
  meetingId: string,
  speaker: string,
  name: string,
  loadArtifact: <U>(
    meetingId: string,
    kind: MeetingArtifactKind,
  ) => Promise<U | null>,
  saveArtifact: <U>(
    meetingId: string,
    kind: MeetingArtifactKind,
    data: U,
  ) => Promise<void>,
): Promise<void> {
  const savedNames = await loadArtifact<Record<string, string>>(
    meetingId,
    'speaker-names',
  );

  await saveArtifact(meetingId, 'speaker-names', {
    ...(savedNames ?? {}),
    [speaker]: name,
  });
}

function mergeSpeakerTurns(
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

function renumberSpeakersSequentially(turns: SpeakerTurn[]): SpeakerTurn[] {
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

function speakerTurnsEqual(
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

function mergeAdjacentSpeakerTurns(turns: SpeakerTurn[]): SpeakerTurn[] {
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

function assignWordToAdjacentSpeaker(
  diarization: SpeakerTurn[],
  wordTurns: SpeakerWordTurn[],
  state: WordAssignmentPopoverState,
  direction: 'previous' | 'next',
): SpeakerTurn[] {
  const wordTurn = wordTurns[state.turnIndex];

  if (wordTurn === undefined) {
    return diarization;
  }

  const diarizationIndex = diarization.findIndex(
    (turn) =>
      turn.speaker === wordTurn.speaker &&
      turn.startSeconds === wordTurn.startSeconds &&
      turn.endSeconds === wordTurn.endSeconds,
  );

  if (diarizationIndex === -1) {
    return diarization;
  }

  const adjusted = diarization.map((turn) => ({ ...turn }));
  const currentTurn = adjusted[diarizationIndex];

  if (currentTurn === undefined) {
    return diarization;
  }

  if (direction === 'previous') {
    const previousTurn = adjusted[diarizationIndex - 1];

    if (previousTurn === undefined) {
      return diarization;
    }

    const nextWord = wordTurn.words[state.wordIndex + 1];
    const boundarySeconds = clampBoundarySeconds(
      nextWord !== undefined
        ? nextWord.timestampInMs / 1000
        : state.wordTimestampInMs / 1000 + 0.001,
      previousTurn.startSeconds,
      currentTurn.endSeconds,
    );

    previousTurn.endSeconds = boundarySeconds;
    currentTurn.startSeconds = boundarySeconds;
    return mergeAdjacentSpeakerTurns(adjusted);
  }

  const nextTurn = adjusted[diarizationIndex + 1];

  if (nextTurn === undefined) {
    return diarization;
  }

  const boundarySeconds = clampBoundarySeconds(
    state.wordTimestampInMs / 1000,
    currentTurn.startSeconds,
    nextTurn.endSeconds,
  );

  currentTurn.endSeconds = boundarySeconds;
  nextTurn.startSeconds = boundarySeconds;
  return mergeAdjacentSpeakerTurns(adjusted);
}

function assignWordRangeToSpeaker(
  diarization: SpeakerTurn[],
  wordTurns: SpeakerWordTurn[],
  state: WordAssignmentPopoverState,
  range: 'through-word' | 'from-word',
  speaker: string,
): SpeakerTurn[] {
  const wordTurn = wordTurns[state.turnIndex];

  if (wordTurn === undefined) {
    return diarization;
  }

  const diarizationIndex = diarization.findIndex(
    (turn) =>
      turn.speaker === wordTurn.speaker &&
      turn.startSeconds === wordTurn.startSeconds &&
      turn.endSeconds === wordTurn.endSeconds,
  );

  if (diarizationIndex === -1) {
    return diarization;
  }

  const currentTurn = diarization[diarizationIndex];

  if (currentTurn === undefined) {
    return diarization;
  }

  const selectedWord = wordTurn.words[state.wordIndex];

  if (selectedWord === undefined) {
    return diarization;
  }

  const rangeStartSeconds =
    range === 'through-word'
      ? currentTurn.startSeconds
      : selectedWord.timestampInMs / 1000;
  const nextWord = wordTurn.words[state.wordIndex + 1];
  const rangeEndSeconds =
    range === 'through-word'
      ? nextWord !== undefined
        ? nextWord.timestampInMs / 1000
        : currentTurn.endSeconds
      : currentTurn.endSeconds;
  const replacementTurns = splitTurnBySpeakerRange(
    currentTurn,
    rangeStartSeconds,
    rangeEndSeconds,
    speaker,
  );

  return mergeAdjacentSpeakerTurns([
    ...diarization.slice(0, diarizationIndex),
    ...replacementTurns,
    ...diarization.slice(diarizationIndex + 1),
  ]);
}

function splitTurnBySpeakerRange(
  turn: SpeakerTurn,
  rangeStartSeconds: number,
  rangeEndSeconds: number,
  speaker: string,
): SpeakerTurn[] {
  const clampedStart = clampBoundarySeconds(
    rangeStartSeconds,
    turn.startSeconds,
    turn.endSeconds,
  );
  const clampedEnd = clampBoundarySeconds(
    rangeEndSeconds,
    clampedStart,
    turn.endSeconds,
  );

  return [
    { ...turn, endSeconds: clampedStart },
    {
      ...turn,
      speaker,
      startSeconds: clampedStart,
      endSeconds: clampedEnd,
    },
    { ...turn, startSeconds: clampedEnd },
  ].filter((nextTurn) => nextTurn.endSeconds > nextTurn.startSeconds);
}

function clampBoundarySeconds(
  boundarySeconds: number,
  minSeconds: number,
  maxSeconds: number,
): number {
  return Math.min(Math.max(boundarySeconds, minSeconds), maxSeconds);
}

function alignDiarizationToSentences(
  diarization: SpeakerTurn[],
  words: TimestampedWord[],
): SpeakerTurn[] {
  const maxAdjustmentSeconds = 2;
  const sortedWords = [...words].sort(
    (first, second) => first.timestampInMs - second.timestampInMs,
  );
  const adjusted = [...diarization]
    .sort((first, second) => first.startSeconds - second.startSeconds)
    .map((turn) => ({ ...turn }));

  for (let index = 0; index < adjusted.length - 1; index += 1) {
    const currentTurn = adjusted[index];
    const nextTurn = adjusted[index + 1];

    if (currentTurn === undefined || nextTurn === undefined) {
      continue;
    }

    const boundarySeconds = currentTurn.endSeconds;
    const previousWordIndex = findPreviousWordIndex(
      sortedWords,
      boundarySeconds,
    );

    if (
      previousWordIndex !== -1 &&
      isSentenceEndingWord(sortedWords[previousWordIndex]?.word ?? '')
    ) {
      continue;
    }

    const candidates = sortedWords
      .map((word, wordIndex) => ({ word, wordIndex }))
      .filter(({ word }) => isSentenceEndingWord(word.word))
      .map(({ wordIndex }) => {
        const nextWord = sortedWords[wordIndex + 1];
        const candidateSeconds =
          nextWord !== undefined
            ? nextWord.timestampInMs / 1000
            : sortedWords[wordIndex]!.timestampInMs / 1000 + 0.001;
        const deltaSeconds = candidateSeconds - boundarySeconds;

        return {
          seconds: candidateSeconds,
          deltaSeconds,
          movedWords: countWordsBetween(
            sortedWords,
            boundarySeconds,
            candidateSeconds,
          ),
        };
      })
      .filter(
        (candidate) =>
          Math.abs(candidate.deltaSeconds) <= maxAdjustmentSeconds &&
          candidate.seconds > currentTurn.startSeconds &&
          candidate.seconds < nextTurn.endSeconds &&
          candidate.movedWords > 0,
      )
      .sort(
        (first, second) =>
          first.movedWords - second.movedWords ||
          Math.abs(first.deltaSeconds) - Math.abs(second.deltaSeconds),
      );

    const bestCandidate = candidates[0];

    if (bestCandidate === undefined) {
      continue;
    }

    currentTurn.endSeconds = bestCandidate.seconds;
    nextTurn.startSeconds = bestCandidate.seconds;
  }

  return mergeAdjacentSpeakerTurns(adjusted);
}

function findPreviousWordIndex(
  words: TimestampedWord[],
  boundarySeconds: number,
): number {
  let previousIndex = -1;

  for (let index = 0; index < words.length; index += 1) {
    if (words[index]!.timestampInMs / 1000 >= boundarySeconds) {
      break;
    }

    previousIndex = index;
  }

  return previousIndex;
}

function countWordsBetween(
  words: TimestampedWord[],
  firstSeconds: number,
  secondSeconds: number,
): number {
  const startSeconds = Math.min(firstSeconds, secondSeconds);
  const endSeconds = Math.max(firstSeconds, secondSeconds);

  return words.filter((word) => {
    const seconds = word.timestampInMs / 1000;

    return seconds >= startSeconds && seconds < endSeconds;
  }).length;
}

function isSentenceEndingWord(word: string): boolean {
  return /[.!?]["')\]]*$/.test(word.trim());
}

interface ArtifactTabProps<T> {
  meetingId: string;
  kind: MeetingArtifactKind;
  present: boolean;
  revision: number;
  loadArtifact: <U>(
    meetingId: string,
    kind: MeetingArtifactKind,
  ) => Promise<U | null>;
  render: (
    data: T,
    setData: Dispatch<SetStateAction<T | null>>,
  ) => ReactElement;
}

function ArtifactTab<T>({
  meetingId,
  kind,
  present,
  revision,
  loadArtifact,
  render,
}: ArtifactTabProps<T>) {
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
    loadArtifact<T>(meetingId, kind)
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
  }, [meetingId, kind, present, revision, loadArtifact]);

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
