import type {
  LanguageMode,
  MeetingDerivationKind,
  StoredMeeting,
  StoredMeetingSummary,
} from './stored-meeting';
import type {
  ChatThread,
  ChatThreadMeta,
  DelegateLog,
  ScanLog,
} from './chat-thread';
import type {
  MeetingArtifact,
  MeetingArtifactSummary,
  MeetingArtifactVersion,
} from './meeting-artifact';

const METADATA_FILE = 'meeting.json';
const DERIVATION_FILES: Record<MeetingDerivationKind, string> = {
  transcript: 'transcript.json',
  diarization: 'diarization.json',
  'word-sync': 'word-sync.json',
  'speaker-names': 'speaker-names.json',
};

const CHAT_DIR = 'chat';
const THREAD_META_FILE = 'meta.json';
const THREAD_FILE = 'thread.json';
const DELEGATES_DIR = 'delegates';
const SCANS_DIR = 'scans';
const ARTIFACTS_DIR = 'artifacts';
const ARTIFACT_HISTORY_DIR = '.history';
const ARTIFACT_EXTENSION = '.md';

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
  languageMode?: LanguageMode;
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

    return { ...meeting, derivations: emptyDerivationMap() };
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
      ...(patch.languageMode !== undefined
        ? { languageMode: patch.languageMode }
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

  async saveDerivation<T>(
    id: string,
    kind: MeetingDerivationKind,
    data: T,
  ): Promise<void> {
    const meetingDir = await this.directoryHandle.getDirectoryHandle(id);
    await writeJson(meetingDir, DERIVATION_FILES[kind], data);
  }

  async deleteDerivation(
    id: string,
    kind: MeetingDerivationKind,
  ): Promise<void> {
    const meetingDir = await this.directoryHandle.getDirectoryHandle(id);

    try {
      await meetingDir.removeEntry(DERIVATION_FILES[kind]);
    } catch {
      // Already absent; nothing to do.
    }
  }

  async loadDerivation<T>(
    id: string,
    kind: MeetingDerivationKind,
  ): Promise<T | null> {
    const meetingDir = await this.directoryHandle.getDirectoryHandle(id);

    try {
      return await readJson<T>(meetingDir, DERIVATION_FILES[kind]);
    } catch {
      return null;
    }
  }

  // --- Chat threads ---------------------------------------------------------

  async listThreads(meetingId: string): Promise<ChatThreadMeta[]> {
    const chatDir = await this.#getChatDir(meetingId, false);

    if (chatDir === null) {
      return [];
    }

    const metas: ChatThreadMeta[] = [];
    const iterable = chatDir as IterableDirectoryHandle;

    for await (const [, handle] of iterable.entries()) {
      if (handle.kind !== 'directory') {
        continue;
      }

      try {
        metas.push(
          await readJson<ChatThreadMeta>(
            handle as FileSystemDirectoryHandle,
            THREAD_META_FILE,
          ),
        );
      } catch {
        // Skip thread directories without valid metadata.
      }
    }

    return metas.sort((first, second) => second.updatedAt - first.updatedAt);
  }

  async loadThread(
    meetingId: string,
    threadId: string,
  ): Promise<ChatThread | null> {
    const chatDir = await this.#getChatDir(meetingId, false);

    if (chatDir === null) {
      return null;
    }

    try {
      const threadDir = await chatDir.getDirectoryHandle(threadId);
      return await readJson<ChatThread>(threadDir, THREAD_FILE);
    } catch {
      return null;
    }
  }

  async saveThread(meetingId: string, thread: ChatThread): Promise<void> {
    const chatDir = await this.#getChatDir(meetingId, true);
    const threadDir = await chatDir!.getDirectoryHandle(thread.id, {
      create: true,
    });

    const meta: ChatThreadMeta = {
      id: thread.id,
      meetingId: thread.meetingId,
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      messageCount: thread.messages.length,
      transcriptStatus: thread.transcriptStatus,
    };

    await writeJson(threadDir, THREAD_FILE, thread);
    await writeJson(threadDir, THREAD_META_FILE, meta);
  }

  async deleteThread(meetingId: string, threadId: string): Promise<void> {
    const chatDir = await this.#getChatDir(meetingId, false);

    if (chatDir === null) {
      return;
    }

    try {
      await chatDir.removeEntry(threadId, { recursive: true });
    } catch {
      // Already absent; nothing to do.
    }
  }

  async saveDelegateLog(
    meetingId: string,
    threadId: string,
    log: DelegateLog,
  ): Promise<void> {
    const chatDir = await this.#getChatDir(meetingId, true);
    const threadDir = await chatDir!.getDirectoryHandle(threadId, {
      create: true,
    });
    const delegatesDir = await threadDir.getDirectoryHandle(DELEGATES_DIR, {
      create: true,
    });
    await writeJson(delegatesDir, `${log.id}.json`, log);
  }

  async loadDelegateLog(
    meetingId: string,
    threadId: string,
    delegateId: string,
  ): Promise<DelegateLog | null> {
    const chatDir = await this.#getChatDir(meetingId, false);

    if (chatDir === null) {
      return null;
    }

    try {
      const threadDir = await chatDir.getDirectoryHandle(threadId);
      const delegatesDir = await threadDir.getDirectoryHandle(DELEGATES_DIR);
      return await readJson<DelegateLog>(delegatesDir, `${delegateId}.json`);
    } catch {
      return null;
    }
  }

  async saveScanLog(
    meetingId: string,
    threadId: string,
    log: ScanLog,
  ): Promise<void> {
    const chatDir = await this.#getChatDir(meetingId, true);
    const threadDir = await chatDir!.getDirectoryHandle(threadId, {
      create: true,
    });
    const scansDir = await threadDir.getDirectoryHandle(SCANS_DIR, {
      create: true,
    });
    await writeJson(scansDir, `${log.id}.json`, log);
  }

  async loadScanLog(
    meetingId: string,
    threadId: string,
    scanId: string,
  ): Promise<ScanLog | null> {
    const chatDir = await this.#getChatDir(meetingId, false);

    if (chatDir === null) {
      return null;
    }

    try {
      const threadDir = await chatDir.getDirectoryHandle(threadId);
      const scansDir = await threadDir.getDirectoryHandle(SCANS_DIR);
      return await readJson<ScanLog>(scansDir, `${scanId}.json`);
    } catch {
      return null;
    }
  }

  // --- Chat artifacts -------------------------------------------------------

  async listArtifacts(meetingId: string): Promise<MeetingArtifactSummary[]> {
    const artifactsDir = await this.#getArtifactsDir(meetingId, false);

    if (artifactsDir === null) {
      return [];
    }

    const summaries: MeetingArtifactSummary[] = [];
    const iterable = artifactsDir as IterableDirectoryHandle;

    for await (const [name, handle] of iterable.entries()) {
      if (handle.kind !== 'file' || !name.endsWith(ARTIFACT_EXTENSION)) {
        continue;
      }

      const file = await (handle as FileSystemFileHandle).getFile();
      const artifactName = name.slice(0, -ARTIFACT_EXTENSION.length);
      summaries.push({
        name: artifactName,
        fileName: name,
        size: file.size,
        updatedAt: file.lastModified,
        versionCount: (await this.listArtifactVersions(meetingId, artifactName))
          .length,
      });
    }

    return summaries.sort((first, second) => second.updatedAt - first.updatedAt);
  }

  async readArtifact(
    meetingId: string,
    name: string,
  ): Promise<MeetingArtifact | null> {
    const safeName = sanitizeArtifactName(name);
    const artifactsDir = await this.#getArtifactsDir(meetingId, false);

    if (artifactsDir === null) {
      return null;
    }

    const fileName = `${safeName}${ARTIFACT_EXTENSION}`;

    try {
      const fileHandle = await artifactsDir.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      return {
        name: safeName,
        fileName,
        size: file.size,
        updatedAt: file.lastModified,
        versionCount: (await this.listArtifactVersions(meetingId, safeName))
          .length,
        content: await file.text(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Write an artifact, keeping the superseded version in history. Overwriting
   * "the" summary never loses the earlier good version.
   */
  async writeArtifact(
    meetingId: string,
    name: string,
    content: string,
  ): Promise<MeetingArtifactSummary> {
    const safeName = sanitizeArtifactName(name);
    const artifactsDir = await this.#getArtifactsDir(meetingId, true);
    const fileName = `${safeName}${ARTIFACT_EXTENSION}`;

    await this.#archiveArtifactVersion(artifactsDir!, safeName, fileName);
    await writeText(artifactsDir!, fileName, content);

    const file = await (await artifactsDir!.getFileHandle(fileName)).getFile();
    return {
      name: safeName,
      fileName,
      size: file.size,
      updatedAt: file.lastModified,
      versionCount: (await this.listArtifactVersions(meetingId, safeName))
        .length,
    };
  }

  async deleteArtifact(meetingId: string, name: string): Promise<void> {
    const safeName = sanitizeArtifactName(name);
    const artifactsDir = await this.#getArtifactsDir(meetingId, false);

    if (artifactsDir === null) {
      return;
    }

    try {
      await artifactsDir.removeEntry(`${safeName}${ARTIFACT_EXTENSION}`);
    } catch {
      // Already absent; nothing to do.
    }
  }

  async listArtifactVersions(
    meetingId: string,
    name: string,
  ): Promise<MeetingArtifactVersion[]> {
    const safeName = sanitizeArtifactName(name);
    const artifactsDir = await this.#getArtifactsDir(meetingId, false);

    if (artifactsDir === null) {
      return [];
    }

    let historyDir: FileSystemDirectoryHandle;
    try {
      historyDir = await artifactsDir.getDirectoryHandle(ARTIFACT_HISTORY_DIR);
    } catch {
      return [];
    }

    const prefix = `${safeName}.`;
    const versions: MeetingArtifactVersion[] = [];
    const iterable = historyDir as IterableDirectoryHandle;

    for await (const [fileName, handle] of iterable.entries()) {
      if (
        handle.kind !== 'file' ||
        !fileName.startsWith(prefix) ||
        !fileName.endsWith(ARTIFACT_EXTENSION)
      ) {
        continue;
      }

      const stamp = Number(
        fileName.slice(prefix.length, -ARTIFACT_EXTENSION.length),
      );
      const file = await (handle as FileSystemFileHandle).getFile();
      versions.push({
        supersededAt: Number.isNaN(stamp) ? file.lastModified : stamp,
        fileName,
        size: file.size,
      });
    }

    return versions.sort((first, second) => second.supersededAt - first.supersededAt);
  }

  async readArtifactVersion(
    meetingId: string,
    versionFileName: string,
  ): Promise<string | null> {
    const artifactsDir = await this.#getArtifactsDir(meetingId, false);

    if (artifactsDir === null) {
      return null;
    }

    try {
      const historyDir = await artifactsDir.getDirectoryHandle(
        ARTIFACT_HISTORY_DIR,
      );
      const fileHandle = await historyDir.getFileHandle(versionFileName);
      return (await fileHandle.getFile()).text();
    } catch {
      return null;
    }
  }

  async #archiveArtifactVersion(
    artifactsDir: FileSystemDirectoryHandle,
    safeName: string,
    fileName: string,
  ): Promise<void> {
    let existing: File;
    try {
      existing = await (await artifactsDir.getFileHandle(fileName)).getFile();
    } catch {
      return;
    }

    const historyDir = await artifactsDir.getDirectoryHandle(
      ARTIFACT_HISTORY_DIR,
      { create: true },
    );
    const stamp = existing.lastModified || Date.now();
    await writeText(
      historyDir,
      `${safeName}.${stamp}${ARTIFACT_EXTENSION}`,
      await existing.text(),
    );
  }

  async #getChatDir(
    meetingId: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | null> {
    return this.#getSubDir(meetingId, CHAT_DIR, create);
  }

  async #getArtifactsDir(
    meetingId: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | null> {
    return this.#getSubDir(meetingId, ARTIFACTS_DIR, create);
  }

  async #getSubDir(
    meetingId: string,
    name: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | null> {
    const meetingDir = await this.directoryHandle.getDirectoryHandle(meetingId);

    try {
      return await meetingDir.getDirectoryHandle(name, { create });
    } catch {
      return null;
    }
  }

  async #loadSummary(
    meetingDir: FileSystemDirectoryHandle,
  ): Promise<StoredMeetingSummary> {
    const meeting = await readJson<StoredMeeting>(meetingDir, METADATA_FILE);
    const derivations = emptyDerivationMap();

    for (const [kind, fileName] of Object.entries(DERIVATION_FILES) as [
      MeetingDerivationKind,
      string,
    ][]) {
      derivations[kind] = await fileExists(meetingDir, fileName);
    }

    return { ...meeting, derivations };
  }
}

function emptyDerivationMap(): Record<MeetingDerivationKind, boolean> {
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

async function writeText(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  content: string,
): Promise<void> {
  const blob = new Blob([content], { type: 'text/markdown' });
  await writeBlob(directory, fileName, blob);
}

/**
 * Reduce an arbitrary artifact name to a safe, stable file stem. Keeps letters,
 * digits, spaces, dashes and underscores; collapses everything else.
 */
function sanitizeArtifactName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9 _-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
    .trim();

  if (cleaned.length === 0) {
    throw new Error(`Invalid artifact name: ${name}`);
  }

  return cleaned;
}

function generateMeetingId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `meeting-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}
