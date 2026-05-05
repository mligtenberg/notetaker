import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  type SpeakerTurn,
  type Transcript,
} from '@notetaker/engine';
import { FileSystem } from '@notetaker/filesystem';
import {
  ModelManager,
  type ManagedModel,
  type ModelVersionManifestEntry,
} from '@notetaker/model-manager';
import EngineWorker from './engine.worker.ts?worker';
import type {
  EngineWorkerRequest,
  EngineWorkerResponse,
} from './engine.worker';
import { MeetingDetailPage } from './components/meeting-detail-page';
import { MeetingsPage } from './components/meetings-page';
import { ModelsPage } from './components/models-page';
import styles from './app.module.css';
import type {
  DownloadProgressState,
  EngineStatus,
  LiveTranscriptSegment,
} from './app.types';
import {
  PAGE_PATHS,
  SETTINGS_MODEL_PAGES,
  resolveActivePage,
  resolveSettingsModel,
  resolveViewingMeetingId,
} from './app-routing';
import { formatBytes, formatDate, formatTimestamp } from './utils/formatters';
import {
  MODEL_DOWNLOAD_SECTIONS,
  MODEL_DOWNLOAD_TARGETS,
  downloadBlobWithProgress,
  getDirectDownloadKey,
  getDirectDownloadVersion as findDirectDownloadVersion,
  getKnownDownloadSize,
  getModelVersionTitle,
  getModelVersions as filterModelVersions,
  getQuantizedVersionName,
  type DirectModelDownload,
} from './services/model-downloads';
import { DownloadProgressDialog } from './components/download-progress-dialog';
import { EngineLogDialog } from './components/engine-log-dialog';
import { useMeetingsController } from './hooks/use-meetings-controller';

type WebGpuSupport = 'checking' | 'supported' | 'unsupported';
type NavigatorWithWebGpu = Navigator & {
  gpu?: {
    requestAdapter(): Promise<unknown>;
  };
};

const fileSystem = new FileSystem();

const WHISPER_SAMPLE_RATE = 16_000;

async function decodeAudioBlobToMonoFloat32(
  blob: Blob,
  targetSampleRate: number,
  onDebug?: (line: string) => void,
): Promise<Float32Array> {
  onDebug?.(
    `[decode] source blob size=${formatBytes(blob.size)} type=${blob.type || 'unknown'}`,
  );

  if (blob.size === 0) {
    throw new Error('Selected media file is empty.');
  }

  const arrayBuffer = await blob.arrayBuffer();
  onDebug?.(
    `[decode] loaded ${formatBytes(arrayBuffer.byteLength)} into memory.`,
  );
  const decodeContext = new AudioContext();

  try {
    const decoded = await decodeContext
      .decodeAudioData(arrayBuffer.slice(0))
      .catch((error: unknown) => {
        throw new Error(
          `Could not decode an audio track from this media file: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    onDebug?.(
      `[decode] decoded duration=${decoded.duration.toFixed(3)}s sampleRate=${decoded.sampleRate} channels=${decoded.numberOfChannels} frames=${decoded.length}`,
    );
    const frameCount = Math.ceil(decoded.duration * targetSampleRate);
    if (!Number.isFinite(decoded.duration) || frameCount <= 0) {
      throw new Error(
        `Decoded audio is empty (${formatBytes(blob.size)} source file).`,
      );
    }

    const offlineContext = new OfflineAudioContext(
      1,
      frameCount,
      targetSampleRate,
    );
    const source = offlineContext.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineContext.destination);
    source.start();
    const rendered = await offlineContext.startRendering();
    const samples = rendered.getChannelData(0).slice();
    const renderedDuration = samples.length / targetSampleRate;
    onDebug?.(
      `[decode] resampled frames=${samples.length} duration=${renderedDuration.toFixed(3)}s targetSampleRate=${targetSampleRate}`,
    );
    if (samples.length === 0) {
      throw new Error(
        `Resampled audio is empty (${decoded.duration.toFixed(3)}s decoded duration).`,
      );
    }

    if (renderedDuration < 0.1) {
      throw new Error(
        `Decoded audio is unexpectedly short (${renderedDuration.toFixed(3)}s from ${formatBytes(blob.size)} source file).`,
      );
    }

    return samples;
  } finally {
    void decodeContext.close();
  }
}

function renumberSpeakersSequentially(turns: SpeakerTurn[]): SpeakerTurn[] {
  const speakers = [...new Set(turns.map((turn) => turn.speaker))].sort();
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

async function detectWebGpuSupport(): Promise<boolean> {
  const gpu = (navigator as NavigatorWithWebGpu).gpu;

  if (gpu === undefined) {
    return false;
  }

  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

function getWhisperRuntimeLabel(version: ModelVersionManifestEntry): string {
  const quantization =
    version.quantization ?? version.metadata?.['quantization'];

  return typeof quantization === 'string' && quantization.length > 0
    ? `auto device with ${quantization} quantization from the active Whisper model`
    : 'auto device with quantization from the active Whisper model';
}

export function App() {
  const modelManagerRef = useRef<ModelManager | null>(null);
  const engineWorkerRef = useRef<Worker | null>(null);
  const engineRequestIdRef = useRef(0);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>('idle');
  const [modelMessage, setModelMessage] = useState(
    'Opening OPFS models folder...',
  );
  const [engineMessage, setEngineMessage] = useState(
    'Select a meeting and run the engine.',
  );
  const [modelVersions, setModelVersions] = useState<
    ModelVersionManifestEntry[]
  >([]);
  const [downloadingModel, setDownloadingModel] = useState<ManagedModel | null>(
    null,
  );
  const [engineDialogOpen, setEngineDialogOpen] = useState(false);
  const [engineDialogMode, setEngineDialogMode] = useState<
    'engine' | 'transcription'
  >('engine');
  const [engineLog, setEngineLog] = useState<string[]>([]);
  const [liveTranscriptSegments, setLiveTranscriptSegments] = useState<
    LiveTranscriptSegment[]
  >([]);
  const [liveTranscriptMeetingId, setLiveTranscriptMeetingId] = useState<
    string | null
  >(null);
  const [webGpuSupport, setWebGpuSupport] = useState<WebGpuSupport>('checking');
  const location = useLocation();
  const navigate = useNavigate();
  const activePage = resolveActivePage(location.pathname);
  const viewingMeetingId = resolveViewingMeetingId(location.pathname);
  const activeSettingsModel = resolveSettingsModel(location.pathname);
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgressState | null>(null);
  const {
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
  } = useMeetingsController({
    navigate,
    viewingMeetingId,
    onSelectedMeetingDeleted: () => {
      setEngineMessage('Select a meeting and run the engine.');
    },
  });

  useEffect(() => {
    if (location.pathname === '/' || location.pathname === '') {
      navigate('/meetings', { replace: true });
    }

    if (
      location.pathname === '/settings' ||
      location.pathname === '/settings/models'
    ) {
      navigate('/settings/models/transcription', { replace: true });
    }
  }, [location.pathname, navigate]);

  async function refreshModelVersions(modelManager = modelManagerRef.current) {
    if (modelManager === null) {
      return;
    }

    setModelVersions(await modelManager.listVersions());
  }

  function getDirectDownloadVersion(
    download: DirectModelDownload,
    versions = modelVersions,
  ): ModelVersionManifestEntry | undefined {
    return findDirectDownloadVersion(download, versions);
  }

  useEffect(() => {
    let isMounted = true;

    void detectWebGpuSupport().then((supported) => {
      if (isMounted) {
        setWebGpuSupport(supported ? 'supported' : 'unsupported');
      }
    });

    async function setupModels() {
      try {
        const modelManager = await ModelManager.create(fileSystem);

        if (!isMounted) {
          return;
        }

        modelManagerRef.current = modelManager;
        await refreshModelVersions(modelManager);
        setModelMessage(
          'Ready. Manage downloaded model versions in OPFS/models.',
        );
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setModelMessage(
          error instanceof Error
            ? error.message
            : 'Failed to open OPFS models folder.',
        );
      }
    }

    void setupModels();

    return () => {
      isMounted = false;
      engineWorkerRef.current?.terminate();
      engineWorkerRef.current = null;
    };
  }, []);

  function getModelVersions(model: ManagedModel): ModelVersionManifestEntry[] {
    return filterModelVersions(modelVersions, model);
  }

  async function handleSetActiveModelVersion(
    model: ManagedModel,
    version: string,
  ) {
    const modelManager = modelManagerRef.current;

    if (modelManager === null || version.length === 0) {
      return;
    }

    try {
      setModelMessage(`Activating ${model} ${version}...`);
      await modelManager.setActiveVersion(model, version);
      await refreshModelVersions(modelManager);
      setModelMessage(`Activated ${model} ${version}.`);
    } catch (error) {
      setModelMessage(
        error instanceof Error ? error.message : 'Failed to activate model.',
      );
    }
  }

  async function handleDownloadDirectModel(download: DirectModelDownload) {
    const modelManager = modelManagerRef.current;

    if (modelManager === null) {
      setModelMessage('Models folder is not ready yet.');
      return;
    }

    try {
      setDownloadingModel(download.model);
      setModelMessage(`Downloading ${download.label} from ${download.id}...`);

      const files = [];
      const knownTotalBytes = getKnownDownloadSize(download);
      let completedBytes = 0;

      for (const [index, file] of download.files.entries()) {
        setDownloadProgress({
          title: `Downloading ${download.label}`,
          currentFile: file.path,
          fileIndex: index + 1,
          fileCount: download.files.length,
          loadedBytes: completedBytes,
          totalBytes: knownTotalBytes ?? null,
          status: 'downloading',
        });

        const blob = await downloadBlobWithProgress(
          file,
          (loadedBytes, fileTotalBytes) => {
            const fallbackTotalBytes =
              knownTotalBytes ??
              completedBytes + (fileTotalBytes ?? loadedBytes);
            setDownloadProgress({
              title: `Downloading ${download.label}`,
              currentFile: file.path,
              fileIndex: index + 1,
              fileCount: download.files.length,
              loadedBytes: completedBytes + loadedBytes,
              totalBytes: fallbackTotalBytes,
              status: 'downloading',
            });
          },
        );

        completedBytes += blob.size;

        files.push({
          path: file.path,
          data: blob,
          type: file.type,
        });
      }

      const modelName = getQuantizedVersionName(
        download.id.replaceAll('/', '__'),
        download.quantization,
      );
      const version = `${modelName}--direct--${new Date()
        .toISOString()
        .replaceAll(':', '-')}`;

      setDownloadProgress((currentProgress) =>
        currentProgress === null
          ? null
          : { ...currentProgress, status: 'saving' },
      );

      await modelManager.addVersion({
        model: download.model,
        modelName,
        version,
        quantization: download.quantization,
        activate: true,
        files,
        metadata: {
          title: download.label,
          format: download.model === 'language' ? 'direct-hugging-face' : 'onnx',
          huggingFaceModelId: download.id,
          quantization: download.quantization,
          sourceUrls: download.files.map((file) => file.url),
          gated: false,
        },
      });

      await refreshModelVersions(modelManager);
      setDownloadProgress((currentProgress) =>
        currentProgress === null
          ? null
          : { ...currentProgress, status: 'complete' },
      );
      setModelMessage(`Downloaded and activated ${download.label}.`);
    } catch (error) {
      setDownloadProgress((currentProgress) =>
        currentProgress === null
          ? null
          : { ...currentProgress, status: 'error' },
      );
      setModelMessage(
        error instanceof Error
          ? error.message
          : `Failed to download ${download.label}.`,
      );
    } finally {
      setDownloadingModel(null);
    }
  }

  async function handleRemoveModelVersion(
    version: ModelVersionManifestEntry,
  ): Promise<void> {
    const modelManager = modelManagerRef.current;

    if (modelManager === null) {
      setModelMessage('Models folder is not ready yet.');
      return;
    }

    try {
      setModelMessage(`Removing ${getModelVersionTitle(version)}...`);
      await modelManager.removeVersion(version.model, version.version);
      await refreshModelVersions(modelManager);
      setModelMessage(`Removed ${getModelVersionTitle(version)}.`);
    } catch (error) {
      setModelMessage(
        error instanceof Error ? error.message : 'Failed to remove model.',
      );
    }
  }

  function getEngineWorker(): Worker {
    if (engineWorkerRef.current === null) {
      const worker = new EngineWorker();

      worker.addEventListener('error', (event) => {
        appendEngineLog(
          `[worker] error ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`,
        );
      });
      worker.addEventListener('messageerror', () => {
        appendEngineLog(
          '[worker] messageerror while transferring request/response.',
        );
      });
      engineWorkerRef.current = worker;
    }

    return engineWorkerRef.current;
  }

  function appendEngineLog(line: string): void {
    setEngineLog((current) => [...current, line]);
  }

  function handleWorkerUpdate(msg: EngineWorkerResponse): boolean {
    if (msg.type === 'progress') {
      const { stage, status } = msg.event;
      appendEngineLog(`[${stage}] ${status}`);
      return true;
    }

    if (msg.type === 'log') {
      appendEngineLog(msg.line);
      return true;
    }

    if (msg.type === 'bar') {
      return true;
    }

    if (msg.type === 'live-transcript') {
      setLiveTranscriptSegments(msg.segments);
      return true;
    }

    return false;
  }

  async function handleRunTranscription(meetingId: string = selectedMeetingId) {
    const repo = meetingsRepoRef.current;
    const selectedMeeting = meetings.find(
      (meeting) => meeting.id === meetingId,
    );
    if (repo === null || selectedMeeting === undefined) {
      setEngineMessage('Select a stored meeting first.');
      return;
    }

    const activeWhisper = getActiveModelVersion('transcription');

    if (activeWhisper === undefined) {
      setEngineMessage('Download a Whisper model first.');
      return;
    }

    setEngineStatus('processing');
    setEngineMessage(`Transcribing ${selectedMeeting.name}...`);
    setEngineLog([
      `Starting transcription-only run for ${selectedMeeting.name}.`,
    ]);
    setLiveTranscriptMeetingId(selectedMeeting.id);
    setLiveTranscriptSegments([]);

    try {
      // Drop any previously-saved transcript (and its dependents) before
      // starting. If this run is interrupted (page refresh, crash) the
      // meeting will be left in a clean "no transcript" state rather than
      // showing stale data from a prior run.
      await repo.deleteArtifact(selectedMeeting.id, 'transcript');
      await repo.deleteArtifact(selectedMeeting.id, 'word-sync');
      await repo.deleteArtifact(selectedMeeting.id, 'speaker-names');
      await refreshMeetings(repo);
      setArtifactRevision((current) => current + 1);

      const audioFile = await repo.loadRecording(selectedMeeting.id);
      setEngineMessage(`Decoding ${selectedMeeting.name}...`);
      setEngineLog((current) => [
        ...current,
        `Decoding ${selectedMeeting.name} (${formatBytes(audioFile.size)})...`,
      ]);
      const samples = await decodeAudioBlobToMonoFloat32(
        audioFile,
        WHISPER_SAMPLE_RATE,
        appendEngineLog,
      );
      if (samples.length === 0) {
        throw new Error('Decoded audio produced no samples.');
      }
      const sampleCount = samples.length;
      const sampleDurationSeconds = sampleCount / WHISPER_SAMPLE_RATE;
      setEngineLog((current) => [
        ...current,
        `Decoded ${sampleDurationSeconds.toFixed(3)}s of audio (${sampleCount} samples).`,
        `Runtime: ${getWhisperRuntimeLabel(activeWhisper)}`,
        `Using Whisper ${getModelVersionTitle(activeWhisper)}.`,
      ]);
      setEngineMessage(`Transcribing ${selectedMeeting.name}...`);
      const worker = getEngineWorker();
      const requestId = ++engineRequestIdRef.current;

      const transcript = await new Promise<Transcript>((resolve, reject) => {
        let timeoutId: any;
        const handleMessage = (event: MessageEvent<EngineWorkerResponse>) => {
          const msg = event.data;

          if (msg.id !== requestId) {
            return;
          }

          if (handleWorkerUpdate(msg)) {
            return;
          }

          if (msg.type !== 'result') {
            return;
          }

          worker.removeEventListener('message', handleMessage);
          clearTimeout(timeoutId);

          if (msg.ok) {
            if (msg.mode !== 'transcription') {
              reject(new Error('Worker returned an unexpected engine result.'));
              return;
            }

            setLiveTranscriptSegments(msg.transcript.segments);
            resolve(msg.transcript);
          } else {
            reject(new Error(msg.error));
          }
        };

        worker.addEventListener('message', handleMessage);
        const request: EngineWorkerRequest = {
          id: requestId,
          mode: 'transcription',
          fileName: selectedMeeting.name,
          audio: samples,
          useWebGpu: webGpuSupport === 'supported',
          languageMode: selectedMeeting.languageMode ?? 'auto-once',
        };
        appendEngineLog(
          `[worker] posting transcription request ${requestId} with ${sampleCount} samples (${sampleDurationSeconds.toFixed(3)}s).`,
        );
        worker.postMessage(request, [samples.buffer]);
        appendEngineLog(`[worker] posted transcription request ${requestId}.`);
        timeoutId = setTimeout(() => {
          worker.removeEventListener('message', handleMessage);
          reject(new Error('Worker transcription timed out.'));
        }, 30000);
      });

      await repo.saveArtifact(selectedMeeting.id, 'transcript', transcript);
      await repo.deleteArtifact(selectedMeeting.id, 'word-sync');
      await repo.deleteArtifact(selectedMeeting.id, 'speaker-names');
      await refreshMeetings(repo);
      setArtifactRevision((current) => current + 1);

      setLiveTranscriptMeetingId(null);
      setEngineStatus('idle');
      setEngineMessage(`Transcription completed for ${selectedMeeting.name}.`);
    } catch (error) {
      setLiveTranscriptMeetingId(null);
      setEngineStatus('error');
      const message =
        error instanceof Error ? error.message : 'Transcription failed.';
      setEngineMessage(message);
      appendEngineLog(`[error] ${message}`);
      console.error('[engine] transcription failed', error);
    }
  }

  async function handleRunDiarization(meetingId: string = selectedMeetingId) {
    const repo = meetingsRepoRef.current;
    const selectedMeeting = meetings.find(
      (meeting) => meeting.id === meetingId,
    );

    if (repo === null || selectedMeeting === undefined) {
      setEngineMessage('Select a stored meeting first.');
      return;
    }

    const activePyannote = getActiveModelVersion('diarization');

    if (activePyannote === undefined) {
      setEngineMessage('Download a Pyannote model first.');
      return;
    }

    setEngineStatus('processing');
    setLiveTranscriptMeetingId(null);
    setEngineMessage(`Diarizing ${selectedMeeting.name}...`);
    setEngineLog([`Starting diarization of ${selectedMeeting.name}.`]);

    try {
      await repo.deleteArtifact(selectedMeeting.id, 'diarization');
      await repo.deleteArtifact(selectedMeeting.id, 'word-sync');
      await repo.deleteArtifact(selectedMeeting.id, 'speaker-names');
      await refreshMeetings(repo);
      setArtifactRevision((current) => current + 1);

      const audioFile = await repo.loadRecording(selectedMeeting.id);
      setEngineLog((current) => [
        ...current,
        `Decoding ${selectedMeeting.name} (${formatBytes(audioFile.size)})...`,
      ]);
      const samples = await decodeAudioBlobToMonoFloat32(
        audioFile,
        WHISPER_SAMPLE_RATE,
        appendEngineLog,
      );
      if (samples.length === 0) {
        throw new Error('Decoded audio produced no samples.');
      }
      const sampleCount = samples.length;
      const sampleDurationSeconds = sampleCount / WHISPER_SAMPLE_RATE;
      setEngineLog((current) => [
        ...current,
        `Decoded ${sampleDurationSeconds.toFixed(3)}s of audio (${sampleCount} samples).`,
        `Speaker hint: ${selectedMeeting.participantCount} meeting participants.`,
        `Using Pyannote ${getModelVersionTitle(activePyannote)}.`,
      ]);

      const worker = getEngineWorker();
      const requestId = ++engineRequestIdRef.current;

      const turns = await new Promise<SpeakerTurn[]>((resolve, reject) => {
        let timeoutId: any;
        const handleMessage = (event: MessageEvent<EngineWorkerResponse>) => {
          const msg = event.data;

          if (msg.id !== requestId) {
            return;
          }

          if (msg.type === 'live-transcript') {
            return;
          }

          if (handleWorkerUpdate(msg)) {
            return;
          }

          if (msg.type !== 'result') {
            return;
          }

          worker.removeEventListener('message', handleMessage);
          clearTimeout(timeoutId);

          if (msg.ok) {
            if (msg.mode !== 'diarization') {
              reject(new Error('Worker returned an unexpected result.'));
              return;
            }

            resolve(msg.turns);
          } else {
            reject(new Error(msg.error));
          }
        };

        worker.addEventListener('message', handleMessage);
        const request: EngineWorkerRequest = {
          id: requestId,
          mode: 'diarization',
          fileName: selectedMeeting.name,
          audio: samples,
          useWebGpu: webGpuSupport === 'supported',
          numSpeakers: selectedMeeting.participantCount,
        };
        appendEngineLog(
          `[worker] posting diarization request ${requestId} with ${sampleCount} samples (${sampleDurationSeconds.toFixed(3)}s).`,
        );
        worker.postMessage(request, [samples.buffer]);
        appendEngineLog(`[worker] posted diarization request ${requestId}.`);
        timeoutId = setTimeout(() => {
          worker.removeEventListener('message', handleMessage);
          reject(new Error('Worker diarization timed out.'));
        }, 30000);
      });

      const normalizedTurns = renumberSpeakersSequentially(turns);

      await repo.saveArtifact(selectedMeeting.id, 'diarization', normalizedTurns);
      await repo.deleteArtifact(selectedMeeting.id, 'word-sync');
      await repo.deleteArtifact(selectedMeeting.id, 'speaker-names');
      await refreshMeetings(repo);
      setArtifactRevision((current) => current + 1);

      setEngineStatus('idle');
      setEngineMessage(
        `Diarization completed: ${normalizedTurns.length} speaker turn${normalizedTurns.length === 1 ? '' : 's'} detected.`,
      );
    } catch (error) {
      setEngineStatus('error');
      const message =
        error instanceof Error ? error.message : 'Diarization failed.';
      setEngineMessage(message);
      appendEngineLog(`[error] ${message}`);
      console.error('[engine] diarization failed', error);
    }
  }

  async function handleRunWordSync(meetingId: string) {
    const repo = meetingsRepoRef.current;
    const meeting = meetings.find((m) => m.id === meetingId);

    if (repo === null || meeting === undefined) {
      setEngineMessage('Select a stored meeting first.');
      return;
    }

    if (!meeting.artifacts.transcript || !meeting.artifacts.diarization) {
      setEngineMessage('Generate transcript and diarization first.');
      return;
    }

    if (getActiveModelVersion('text-audio-sync') === undefined) {
      setEngineMessage('Download a Wav2Vec2 model first.');
      return;
    }

    setEngineStatus('processing');
    setLiveTranscriptMeetingId(null);
    setEngineMessage(`Aligning words for ${meeting.name}...`);
    setEngineLog([`Starting word-sync for ${meeting.name}.`]);

    try {
      await repo.deleteArtifact(meetingId, 'word-sync');
      await repo.deleteArtifact(meetingId, 'speaker-names');
      await refreshMeetings(repo);
      setArtifactRevision((current) => current + 1);

      const transcript = await repo.loadArtifact<Transcript>(
        meetingId,
        'transcript',
      );
      if (transcript === null) {
        throw new Error('Transcript artifact missing.');
      }

      const audioFile = await repo.loadRecording(meetingId);
      const samples = await decodeAudioBlobToMonoFloat32(
        audioFile,
        WHISPER_SAMPLE_RATE,
        appendEngineLog,
      );

      const worker = getEngineWorker();
      const requestId = ++engineRequestIdRef.current;

      const words = await new Promise<unknown[]>((resolve, reject) => {
        let timeoutId: any;
        const handleMessage = (event: MessageEvent<EngineWorkerResponse>) => {
          const msg = event.data;
          if (msg.id !== requestId) return;
          if (handleWorkerUpdate(msg)) return;
          if (msg.type !== 'result') return;
          worker.removeEventListener('message', handleMessage);
          clearTimeout(timeoutId);
          if (msg.ok) {
            if (msg.mode !== 'word-sync') {
              reject(new Error('Worker returned an unexpected result.'));
              return;
            }
            resolve(msg.words);
          } else {
            reject(new Error(msg.error));
          }
        };

        worker.addEventListener('message', handleMessage);
        const request: EngineWorkerRequest = {
          id: requestId,
          mode: 'word-sync',
          fileName: meeting.name,
          audio: samples,
          audioSampleRate: WHISPER_SAMPLE_RATE,
          useWebGpu: webGpuSupport === 'supported',
          transcript,
        };
        worker.postMessage(request, [samples.buffer]);
        timeoutId = setTimeout(() => {
          worker.removeEventListener('message', handleMessage);
          reject(new Error('Worker word-sync timed out.'));
        }, 30000);
      });

      await repo.saveArtifact(meetingId, 'word-sync', words);
      await repo.deleteArtifact(meetingId, 'speaker-names');
      await refreshMeetings(repo);
      setArtifactRevision((current) => current + 1);
      setEngineStatus('idle');
      setEngineMessage(
        `Word sync completed for ${meeting.name} (${words.length} words).`,
      );
    } catch (error) {
      setEngineStatus('error');
      const message =
        error instanceof Error ? error.message : 'Word sync failed.';
      setEngineMessage(message);
      appendEngineLog(`[error] ${message}`);
      console.error('[engine] word sync failed', error);
    }
  }

  async function handleRunSpeakerNaming(meetingId: string) {
    const repo = meetingsRepoRef.current;
    const meeting = meetings.find((m) => m.id === meetingId);

    if (repo === null || meeting === undefined) {
      setEngineMessage('Select a stored meeting first.');
      return;
    }

    if (!meeting.artifacts['word-sync']) {
      setEngineMessage('Generate word sync first.');
      return;
    }

    if (getActiveModelVersion('language') === undefined) {
      setEngineMessage('Download a Gemma 4 model first.');
      return;
    }

    setEngineStatus('processing');
    setLiveTranscriptMeetingId(null);
    setEngineMessage(`Naming speakers for ${meeting.name}...`);
    setEngineLog([`Starting speaker naming for ${meeting.name}.`]);

    try {
      await repo.deleteArtifact(meetingId, 'speaker-names');
      await refreshMeetings(repo);
      setArtifactRevision((current) => current + 1);

      const transcript = await repo.loadArtifact<Transcript>(
        meetingId,
        'transcript',
      );
      const turns = await repo.loadArtifact<SpeakerTurn[]>(
        meetingId,
        'diarization',
      );
      if (transcript === null || turns === null) {
        throw new Error('Transcript or diarization artifact missing.');
      }

      const audioFile = await repo.loadRecording(meetingId);
      const samples = await decodeAudioBlobToMonoFloat32(
        audioFile,
        WHISPER_SAMPLE_RATE,
        appendEngineLog,
      );

      const worker = getEngineWorker();
      const requestId = ++engineRequestIdRef.current;

      const names = await new Promise<Record<string, string>>(
        (resolve, reject) => {
          let timeoutId: any;
          const handleMessage = (event: MessageEvent<EngineWorkerResponse>) => {
            const msg = event.data;
            if (msg.id !== requestId) return;
            if (handleWorkerUpdate(msg)) return;
            if (msg.type !== 'result') return;
            worker.removeEventListener('message', handleMessage);
            clearTimeout(timeoutId);
            if (msg.ok) {
              if (msg.mode !== 'speaker-naming') {
                reject(new Error('Worker returned an unexpected result.'));
                return;
              }
              resolve(msg.names);
            } else {
              reject(new Error(msg.error));
            }
          };

          worker.addEventListener('message', handleMessage);
          const request: EngineWorkerRequest = {
            id: requestId,
            mode: 'speaker-naming',
            fileName: meeting.name,
            audio: samples,
            useWebGpu: webGpuSupport === 'supported',
            transcript,
            diarization: turns,
          };
          worker.postMessage(request, [samples.buffer]);
          timeoutId = setTimeout(() => {
            worker.removeEventListener('message', handleMessage);
            reject(new Error('Worker speaker-naming timed out.'));
          }, 30000);
        },
      );

      await repo.saveArtifact(meetingId, 'speaker-names', names);
      await refreshMeetings(repo);
      setArtifactRevision((current) => current + 1);
      setEngineStatus('idle');
      setEngineMessage(`Speaker naming completed for ${meeting.name}.`);
    } catch (error) {
      setEngineStatus('error');
      const message =
        error instanceof Error ? error.message : 'Speaker naming failed.';
      setEngineMessage(message);
      appendEngineLog(`[error] ${message}`);
      console.error('[engine] speaker naming failed', error);
    }
  }

  function getActiveModelVersion(
    model: ManagedModel,
  ): ModelVersionManifestEntry | undefined {
    return modelVersions.find(
      (version) => version.model === model && version.active,
    );
  }

  const activeModelCount = MODEL_DOWNLOAD_TARGETS.filter(
    (target) => getActiveModelVersion(target.model) !== undefined,
  ).length;
  const downloadPercent = downloadProgress?.totalBytes
    ? Math.min(
        100,
        Math.round(
          (downloadProgress.loadedBytes / downloadProgress.totalBytes) * 100,
        ),
      )
    : null;

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span>Notetaker Lab</span>
          <strong>Local meeting engine</strong>
        </div>
        <nav className={styles.nav} aria-label="Application sections">
          {(
            [
              ['meetings', 'Meetings', `${meetings.length} saved`],
              ['settings', 'Settings', `${activeModelCount}/4 models ready`],
            ] as const
          ).map(([page, label, detail]) => (
            <NavLink
              key={page}
              to={PAGE_PATHS[page]}
              data-active={activePage === page}
            >
              <span>{label}</span>
              <small>{detail}</small>
            </NavLink>
          ))}
        </nav>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.hero}>
          <h1>
            {activePage === 'settings'
              ? 'Settings'
                : 'Meetings'}
          </h1>
          <p>
            {activePage === 'settings'
                ? 'Manage local models used by the processing pipeline.'
                : 'Create meetings, capture recordings, and keep notes organized in OPFS.'}
          </p>
        </header>

        {activePage === 'settings' ? (
          <ModelsPage
            modelVersions={modelVersions}
            modelMessage={modelMessage}
            downloadingModel={downloadingModel}
            modelTargets={MODEL_DOWNLOAD_TARGETS}
            downloadSections={MODEL_DOWNLOAD_SECTIONS}
            getKnownDownloadSize={getKnownDownloadSize}
            getDirectDownloadKey={getDirectDownloadKey}
            getDirectDownloadVersion={getDirectDownloadVersion}
            getModelVersions={getModelVersions}
            getModelVersionTitle={getModelVersionTitle}
            onDownloadDirectModel={(download) =>
              void handleDownloadDirectModel(download)
            }
            onSetActiveModelVersion={(model, version) =>
              void handleSetActiveModelVersion(model, version)
            }
            onRemoveModelVersion={(version) =>
              void handleRemoveModelVersion(version)
            }
            activeModel={activeSettingsModel ?? 'transcription'}
            onSelectModelPage={(model) => {
              const page = SETTINGS_MODEL_PAGES.find((item) => item.model === model);
              if (page !== undefined) {
                navigate(`/settings/models/${page.path}`);
              }
            }}
            formatBytes={formatBytes}
          />
        ) : null}

        {activePage === 'meetings' && viewingMeetingId !== null
          ? (() => {
              const viewedMeeting = meetings.find(
                (meeting) => meeting.id === viewingMeetingId,
              );

              if (viewedMeeting === undefined) {
                return (
                  <section className={styles.panel}>
                    <p className={styles.empty}>Meeting not found.</p>
                    <div className={styles.actions}>
                      <button
                        type="button"
                        onClick={() => navigate('/meetings')}
                      >
                        Back to meetings
                      </button>
                    </div>
                  </section>
                );
              }

              return (
                <MeetingDetailPage
                  meeting={viewedMeeting}
                  meetingUrl={meetingUrls[viewedMeeting.id]}
                  isRecording={recordingMeetingId === viewedMeeting.id}
                  status={status}
                  engineStatus={engineStatus}
                  engineMessage={engineMessage}
                  artifactRevision={artifactRevision}
                  liveTranscriptSegments={
                    engineStatus === 'processing' &&
                    liveTranscriptMeetingId === viewedMeeting.id
                      ? liveTranscriptSegments
                      : []
                  }
                  loadArtifact={loadMeetingArtifact}
                  saveArtifact={saveMeetingArtifact}
                  deleteArtifact={deleteMeetingArtifact}
                  onUpdateMeeting={(id, patch) => void updateMeeting(id, patch)}
                  onStartRecording={() =>
                    void startRecording(viewedMeeting.id)
                  }
                  onStopRecording={() => void stopRecording()}
                  onCancelRecording={cancelRecording}
                  onUploadRecording={(file) =>
                    void uploadRecording(viewedMeeting.id, file)
                  }
                  onDeleteMeeting={() =>
                    void deleteMeeting(viewedMeeting)
                  }
                  onRunTranscript={() =>
                    void handleRunTranscription(viewedMeeting.id)
                  }
                  onRunDiarization={() =>
                    void handleRunDiarization(viewedMeeting.id)
                  }
                  onRunWordSync={() => void handleRunWordSync(viewedMeeting.id)}
                  onRunSpeakerNaming={() =>
                    void handleRunSpeakerNaming(viewedMeeting.id)
                  }
                  onOpenLogging={(mode) => {
                    setEngineDialogMode(mode);
                    setEngineDialogOpen(true);
                  }}
                  initialTab={
                    'details'
                  }
                  onBack={() => navigate('/meetings')}
                  formatBytes={formatBytes}
                  formatDate={formatDate}
                  formatTimestamp={formatTimestamp}
                />
              );
            })()
          : null}

        {activePage === 'meetings' && viewingMeetingId === null ? (
          <MeetingsPage
            meetings={meetings}
            message={message}
            isCreating={creatingMeeting}
            onCreateMeeting={() => void createMeeting()}
            onOpenMeeting={(meeting) => navigate(`/meetings/${meeting.id}`)}
            formatDate={formatDate}
          />
        ) : null}

      </section>

      {engineDialogOpen ? (
        <EngineLogDialog
          mode={engineDialogMode}
          status={engineStatus}
          meetingName={
            meetings.find((meeting) => meeting.id === selectedMeetingId)?.name ?? ''
          }
          logLines={engineLog}
          liveTranscriptSegments={liveTranscriptSegments}
          onClose={() => setEngineDialogOpen(false)}
        />
      ) : null}

      {downloadProgress !== null ? (
        <DownloadProgressDialog
          progress={downloadProgress}
          percent={downloadPercent}
          formatBytes={formatBytes}
          onClose={() => setDownloadProgress(null)}
        />
      ) : null}
    </main>
  );
}

export default App;
