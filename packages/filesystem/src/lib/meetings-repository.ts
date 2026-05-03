import type {
  MeetingArtifactKind,
  StoredMeeting,
  StoredMeetingSummary,
} from './stored-meeting';

const METADATA_FILE = 'meeting.json';
const ARTIFACT_FILES: Record<MeetingArtifactKind, string> = {
  transcript: 'transcript.json',
  diarization: 'diarization.json',
  'word-sync': 'word-sync.json',
  'speaker-names': 'speaker-names.json',
};

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

export interface CreateMeetingInput {
  name: string;
  date: string;
  participantCount: number;
}

export interface RecordingInput {
  blob: Blob;
  extension: string;
  mimeType: string;
}

export interface MeetingMetadataPatch {
  name?: string;
  date?: string;
  participantCount?: number;
}

export class MeetingsRepository {
  readonly directoryHandle: FileSystemDirectoryHandle;

  constructor(directoryHandle: FileSystemDirectoryHandle) {
    this.directoryHandle = directoryHandle;
  }

  async list(): Promise<StoredMeetingSummary[]> {
    const summaries: StoredMeetingSummary[] = [];
    const iterable = this.directoryHandle as IterableDirectoryHandle;

    for await (const [, handle] of iterable.entries()) {
      if (handle.kind !== 'directory') {
        continue;
      }

      try {
        const summary = await this.#loadSummary(handle as FileSystemDirectoryHandle);
        summaries.push(summary);
      } catch {
        // Skip directories that don't have valid metadata.
      }
    }

    return summaries.sort((first, second) => second.createdAt - first.createdAt);
  }

  async create(input: CreateMeetingInput): Promise<StoredMeetingSummary> {
    const id = generateMeetingId();
    const meetingDir = await this.directoryHandle.getDirectoryHandle(id, {
      create: true,
    });

    const meeting: StoredMeeting = {
      id,
      name: input.name,
      date: input.date,
      participantCount: input.participantCount,
      recordingFileName: null,
      recordingMimeType: null,
      recordingSize: null,
      createdAt: Date.now(),
    };

    await writeJson(meetingDir, METADATA_FILE, meeting);

    return { ...meeting, artifacts: emptyArtifactMap() };
  }

  async attachRecording(
    id: string,
    recording: RecordingInput,
  ): Promise<StoredMeetingSummary> {
    const meetingDir = await this.directoryHandle.getDirectoryHandle(id);
    const meeting = await readJson<StoredMeeting>(meetingDir, METADATA_FILE);
    const recordingFileName = `recording.${recording.extension}`;

    if (
      meeting.recordingFileName !== null &&
      meeting.recordingFileName !== recordingFileName
    ) {
      try {
        await meetingDir.removeEntry(meeting.recordingFileName);
      } catch {
        // Old recording already gone; ignore.
      }
    }

    await writeBlob(meetingDir, recordingFileName, recording.blob);

    const updated: StoredMeeting = {
      ...meeting,
      recordingFileName,
      recordingMimeType: recording.mimeType,
      recordingSize: recording.blob.size,
    };
    await writeJson(meetingDir, METADATA_FILE, updated);

    return this.#loadSummary(meetingDir);
  }

  async updateMetadata(
    id: string,
    patch: MeetingMetadataPatch,
  ): Promise<StoredMeetingSummary> {
    const meetingDir = await this.directoryHandle.getDirectoryHandle(id);
    const meeting = await readJson<StoredMeeting>(meetingDir, METADATA_FILE);
    const updated: StoredMeeting = {
      ...meeting,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.date !== undefined ? { date: patch.date } : {}),
      ...(patch.participantCount !== undefined
        ? { participantCount: patch.participantCount }
        : {}),
    };
    await writeJson(meetingDir, METADATA_FILE, updated);

    return this.#loadSummary(meetingDir);
  }

  async delete(id: string): Promise<void> {
    await this.directoryHandle.removeEntry(id, { recursive: true });
  }

  async loadRecording(id: string): Promise<File> {
    const meetingDir = await this.directoryHandle.getDirectoryHandle(id);
    const meeting = await readJson<StoredMeeting>(meetingDir, METADATA_FILE);

    if (meeting.recordingFileName === null) {
      throw new Error(`Meeting ${id} has no recording attached.`);
    }

    const fileHandle = await meetingDir.getFileHandle(meeting.recordingFileName);
    return fileHandle.getFile();
  }

  async loadMetadata(id: string): Promise<StoredMeeting> {
    const meetingDir = await this.directoryHandle.getDirectoryHandle(id);
    return readJson<StoredMeeting>(meetingDir, METADATA_FILE);
  }

  async saveArtifact<T>(
    id: string,
    kind: MeetingArtifactKind,
    data: T,
  ): Promise<void> {
    const meetingDir = await this.directoryHandle.getDirectoryHandle(id);
    await writeJson(meetingDir, ARTIFACT_FILES[kind], data);
  }

  async deleteArtifact(
    id: string,
    kind: MeetingArtifactKind,
  ): Promise<void> {
    const meetingDir = await this.directoryHandle.getDirectoryHandle(id);

    try {
      await meetingDir.removeEntry(ARTIFACT_FILES[kind]);
    } catch {
      // Already absent; nothing to do.
    }
  }

  async loadArtifact<T>(
    id: string,
    kind: MeetingArtifactKind,
  ): Promise<T | null> {
    const meetingDir = await this.directoryHandle.getDirectoryHandle(id);

    try {
      return await readJson<T>(meetingDir, ARTIFACT_FILES[kind]);
    } catch {
      return null;
    }
  }

  async #loadSummary(
    meetingDir: FileSystemDirectoryHandle,
  ): Promise<StoredMeetingSummary> {
    const meeting = await readJson<StoredMeeting>(meetingDir, METADATA_FILE);
    const artifacts = emptyArtifactMap();

    for (const [kind, fileName] of Object.entries(ARTIFACT_FILES) as [
      MeetingArtifactKind,
      string,
    ][]) {
      artifacts[kind] = await fileExists(meetingDir, fileName);
    }

    return { ...meeting, artifacts };
  }
}

function emptyArtifactMap(): Record<MeetingArtifactKind, boolean> {
  return {
    transcript: false,
    diarization: false,
    'word-sync': false,
    'speaker-names': false,
  };
}

async function fileExists(
  directory: FileSystemDirectoryHandle,
  fileName: string,
): Promise<boolean> {
  try {
    await directory.getFileHandle(fileName);
    return true;
  } catch {
    return false;
  }
}

async function writeBlob(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  blob: Blob,
): Promise<void> {
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();

  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort();
    throw error;
  }
}

async function writeJson(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  data: unknown,
): Promise<void> {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  await writeBlob(directory, fileName, blob);
}

async function readJson<T>(
  directory: FileSystemDirectoryHandle,
  fileName: string,
): Promise<T> {
  const fileHandle = await directory.getFileHandle(fileName);
  const file = await fileHandle.getFile();
  const text = await file.text();
  return JSON.parse(text) as T;
}

function generateMeetingId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `meeting-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}
