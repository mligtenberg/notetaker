import { useEffect, useRef, useState } from 'react';
import type { SpeakerTurn, Transcript } from '@notetaker/engine';
import type {
  LanguageMode,
  MeetingArtifactKind,
  StoredMeetingSummary,
} from '@notetaker/filesystem';
import styles from '../../app.module.css';
import { Page } from '../common/page';
import { type MeetingTab } from '../../app-routing';
import { MeetingTabs } from './meeting-tabs';
import { DetailsTab } from './meeting-detail/details-tab';
import { RecordingTab } from './meeting-detail/recording-tab';
import {
  LiveTranscriptPreview,
  TranscriptArtifactView,
} from './meeting-detail/transcript-tab';
import { DiarizationArtifactView } from './meeting-detail/diarization-tab';
import { WordSyncArtifactTab } from './meeting-detail/word-sync-tab';
import { SpeakerNamesTab } from './meeting-detail/speaker-names-tab';
import {
  ArtifactTab,
  ArtifactToolbar,
  getActiveMediaRef,
  isEditableTarget,
  toggleRecordingPlayback,
} from './meeting-detail/shared';
import type {
  EngineStatus,
  LiveTranscriptSegment,
  RecorderStatus,
} from './meeting-detail/types';

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
    patch: Partial<{
      name: string;
      date: string;
      participantCount: number;
      languageMode: LanguageMode;
    }>,
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
  activeTab?: MeetingTab;
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
  activeTab = 'details',
  formatBytes,
  formatDate,
  formatTimestamp,
}: MeetingDetailPageProps) {
  const [speakerNamesSaved, setSpeakerNamesSaved] = useState(
    meeting.artifacts['speaker-names'],
  );
  const [loggingAvailableTab, setLoggingAvailableTab] = useState<MeetingTab | null>(
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
    <Page
      title={meeting.name}
      subtitle={`${meeting.date} • ${meeting.participantCount} participant${meeting.participantCount === 1 ? '' : 's'}`}
      headerClassName={styles.detailHeader}
      headerActions={
        <button type="button" onClick={onBack}>
          Back
        </button>
      }
    >
      <MeetingTabs
        meetingId={meeting.id}
        activeTab={activeTab}
        meeting={meeting}
        speakerNamesSaved={speakerNamesSaved}
        onTabChange={() => setLoggingAvailableTab(null)}
      />

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
          onChangeLanguageMode={(mode) =>
            onUpdateMeeting(meeting.id, { languageMode: mode })
          }
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
            <LiveTranscriptPreview segments={liveTranscriptSegments} />
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
    </Page>
  );
}
