import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioRecorder } from '@notetaker/audio-recorder';
import {
  FileSystem,
  MeetingsRepository,
  type LanguageMode,
  type MeetingArtifactKind,
  type StoredMeetingSummary,
} from '@notetaker/filesystem';
import type { NavigateFunction } from 'react-router-dom';
import type { RecorderStatus } from '../app.types';
import { mimeTypeToExtension, todayIsoDate } from '../utils/media-files';

interface UseMeetingsControllerOptions {
  navigate: NavigateFunction;
  viewingMeetingId: string | null;
  onSelectedMeetingDeleted: () => void;
}

export function useMeetingsController({
  navigate,
  viewingMeetingId,
  onSelectedMeetingDeleted,
}: UseMeetingsControllerOptions) {
  const recorderRef = useRef<AudioRecorder | null>(null);
  const meetingsRepoRef = useRef<MeetingsRepository | null>(null);
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [message, setMessage] = useState('');
  const [meetings, setMeetings] = useState<StoredMeetingSummary[]>([]);
  const [artifactRevision, setArtifactRevision] = useState(0);
  const [meetingUrls, setMeetingUrls] = useState<Record<string, string>>({});
  const [creatingMeeting, setCreatingMeeting] = useState(false);
  const [selectedMeetingId, setSelectedMeetingId] = useState('');
  const [recordingMeetingId, setRecordingMeetingId] = useState<string | null>(
    null,
  );

  async function refreshMeetings(repo = meetingsRepoRef.current) {
    if (repo === null) {
      return;
    }

    const summaries = await repo.list();

    setMeetingUrls((current) => {
      const next: Record<string, string> = {};
      const keepIds = new Set(summaries.map((m) => m.id));

      for (const [id, url] of Object.entries(current)) {
        if (keepIds.has(id)) {
          next[id] = url;
        } else {
          URL.revokeObjectURL(url);
        }
      }

      return next;
    });

    setMeetings(summaries);

    const existingUrlsSnapshot = { ...meetingUrls };
    for (const summary of summaries) {
      if (existingUrlsSnapshot[summary.id] !== undefined) {
        continue;
      }

      try {
        const file = await repo.loadRecording(summary.id);
        const url = URL.createObjectURL(file);
        if (existingUrlsSnapshot[summary.id] !== undefined) {
          URL.revokeObjectURL(url);
          continue;
        }
        setMeetingUrls((current) => ({ ...current, [summary.id]: url }));
      } catch {
        // Recording missing; skip url generation.
      }
    }

    if (selectedMeetingId.length === 0 && summaries[0] !== undefined) {
      setSelectedMeetingId(summaries[0].id);
    }
  }

  useEffect(() => {
    let isMounted = true;

    async function setupMeetings() {
      try {
        const meetingsDir = await new FileSystem().getMeetingsDir();

        if (!isMounted) {
          return;
        }

        const repo = new MeetingsRepository(meetingsDir);
        meetingsRepoRef.current = repo;
        recorderRef.current = new AudioRecorder(meetingsDir);
        await refreshMeetings(repo);
        setStatus('ready');
        setMessage('');
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setStatus('error');
        setMessage(
          error instanceof Error
            ? error.message
            : 'Failed to open OPFS meetings folder.',
        );
      }
    }

    void setupMeetings();

    return () => {
      isMounted = false;
      recorderRef.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      for (const url of Object.values(meetingUrls)) {
        URL.revokeObjectURL(url);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createMeeting() {
    const repo = meetingsRepoRef.current;

    if (repo === null || creatingMeeting) {
      return;
    }

    try {
      setCreatingMeeting(true);
      const meeting = await repo.create({
        name: 'Untitled meeting',
        date: todayIsoDate(),
        participantCount: 2,
      });
      await refreshMeetings(repo);
      setSelectedMeetingId(meeting.id);
      setStatus('ready');
      setMessage('');
      navigate(`/meetings/${meeting.id}`);
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error ? error.message : 'Failed to create meeting.',
      );
    } finally {
      setCreatingMeeting(false);
    }
  }

  const loadMeetingArtifact = useCallback(
    <T,>(meetingId: string, kind: MeetingArtifactKind): Promise<T | null> => {
      const repo = meetingsRepoRef.current;

      if (repo === null) {
        return Promise.resolve(null);
      }

      return repo.loadArtifact<T>(meetingId, kind);
    },
    [],
  );

  async function saveMeetingArtifact<T>(
    meetingId: string,
    kind: MeetingArtifactKind,
    data: T,
  ): Promise<void> {
    const repo = meetingsRepoRef.current;

    if (repo === null) {
      throw new Error('Meetings repository is not ready.');
    }

    await repo.saveArtifact(meetingId, kind, data);

    if (kind === 'diarization') {
      await repo.deleteArtifact(meetingId, 'speaker-names');
    }

    await refreshMeetings(repo);
    setArtifactRevision((current) => current + 1);
  }

  async function deleteMeetingArtifact(
    meetingId: string,
    kind: MeetingArtifactKind,
  ): Promise<void> {
    const repo = meetingsRepoRef.current;

    if (repo === null) {
      throw new Error('Meetings repository is not ready.');
    }

    await repo.deleteArtifact(meetingId, kind);
    await refreshMeetings(repo);
    setArtifactRevision((current) => current + 1);
  }

  async function updateMeeting(
    id: string,
    patch: Partial<{
      name: string;
      date: string;
      participantCount: number;
      languageMode: LanguageMode;
    }>,
  ) {
    const repo = meetingsRepoRef.current;

    if (repo === null) {
      return;
    }

    try {
      setMessage('');
      await repo.updateMetadata(id, patch);
      await refreshMeetings(repo);
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error ? error.message : 'Failed to update meeting.',
      );
    }
  }

  async function startRecording(meetingId: string) {
    const recorder = recorderRef.current;
    if (recorder === null) {
      return;
    }

    try {
      setMessage('');
      await recorder.start();
      setRecordingMeetingId(meetingId);
      setStatus('recording');
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error ? error.message : 'Failed to start recording.',
      );
    }
  }

  async function stopRecording() {
    const recorder = recorderRef.current;
    const repo = meetingsRepoRef.current;
    const meetingId = recordingMeetingId;

    if (recorder === null || repo === null || meetingId === null) {
      return;
    }

    try {
      setStatus('saving');
      setMessage('');
      const recording = await recorder.stop();
      try {
        await repo.directoryHandle.removeEntry(recording.fileName);
      } catch {
        // Ignore; scratch file may already be gone.
      }

      await repo.attachRecording(meetingId, {
        blob: recording.blob,
        mimeType: recording.mimeType,
        extension: mimeTypeToExtension(recording.mimeType),
      });

      dropCachedMeetingUrl(meetingId);

      await refreshMeetings(repo);
      setRecordingMeetingId(null);
      setStatus('ready');
      setMessage('');
    } catch (error) {
      setRecordingMeetingId(null);
      setStatus('error');
      setMessage(
        error instanceof Error ? error.message : 'Failed to save recording.',
      );
    }
  }

  async function uploadRecording(meetingId: string, file: File) {
    const repo = meetingsRepoRef.current;

    if (repo === null) {
      return;
    }

    try {
      setStatus('saving');
      setMessage('');

      const mimeType = file.type || 'application/octet-stream';
      const extensionFromName = file.name.includes('.')
        ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
        : '';
      const extension =
        extensionFromName.length > 0
          ? extensionFromName
          : mimeTypeToExtension(mimeType);

      await repo.attachRecording(meetingId, {
        blob: file,
        mimeType,
        extension,
      });

      dropCachedMeetingUrl(meetingId);

      await refreshMeetings(repo);
      setStatus('ready');
      setMessage('');
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error ? error.message : 'Failed to import audio file.',
      );
    }
  }

  async function deleteMeeting(meeting: StoredMeetingSummary) {
    const repo = meetingsRepoRef.current;

    if (repo === null) {
      return;
    }

    const confirmed = window.confirm(`Delete meeting "${meeting.name}"?`);

    if (!confirmed) {
      return;
    }

    try {
      setStatus('saving');
      setMessage('');
      await repo.delete(meeting.id);

      dropCachedMeetingUrl(meeting.id);

      if (selectedMeetingId === meeting.id) {
        setSelectedMeetingId('');
        onSelectedMeetingDeleted();
      }

      if (viewingMeetingId === meeting.id) {
        navigate('/meetings');
      }

      await refreshMeetings(repo);
      setStatus('ready');
      setMessage('');
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error
          ? error.message
          : `Failed to delete meeting "${meeting.name}".`,
      );
    }
  }

  function cancelRecording() {
    recorderRef.current?.cancel();
    setRecordingMeetingId(null);
    setStatus('ready');
    setMessage('');
  }

  function dropCachedMeetingUrl(meetingId: string) {
    setMeetingUrls((current) => {
      const url = current[meetingId];
      if (url === undefined) {
        return current;
      }
      URL.revokeObjectURL(url);
      const next = { ...current };
      delete next[meetingId];
      return next;
    });
  }

  return {
    meetingsRepoRef,
    status,
    message,
    meetings,
    artifactRevision,
    meetingUrls,
    creatingMeeting,
    selectedMeetingId,
    recordingMeetingId,
    refreshMeetings,
    setArtifactRevision,
    createMeeting,
    loadMeetingArtifact,
    saveMeetingArtifact,
    deleteMeetingArtifact,
    updateMeeting,
    startRecording,
    stopRecording,
    uploadRecording,
    deleteMeeting,
    cancelRecording,
  };
}
