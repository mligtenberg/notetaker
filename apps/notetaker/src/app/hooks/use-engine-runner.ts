import {
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { SpeakerTurn, Transcript } from '@notetaker/engine';
import type { MeetingsRepository, StoredMeetingSummary } from '@notetaker/filesystem';
import type { ManagedModel, ModelVersionManifestEntry } from '@notetaker/model-manager';
import EngineWorker from '../engine.worker.ts?worker';
import type { EngineWorkerRequest, EngineWorkerResponse } from '../engine.worker';
import type { EngineStatus, LiveTranscriptSegment } from '../app.types';
import { formatBytes } from '../utils/formatters';
import { getModelVersionTitle } from '../services/model-downloads';

const WHISPER_SAMPLE_RATE = 16_000;

interface UseEngineRunnerOptions {
  meetingsRepoRef: RefObject<MeetingsRepository | null>;
  meetings: StoredMeetingSummary[];
  selectedMeetingId: string;
  refreshMeetings: (repo?: MeetingsRepository | null) => Promise<void>;
  setArtifactRevision: Dispatch<SetStateAction<number>>;
  getActiveModelVersion: (
    model: ManagedModel,
  ) => ModelVersionManifestEntry | undefined;
}

export function useEngineRunner({
  meetingsRepoRef,
  meetings,
  selectedMeetingId,
  refreshMeetings,
  setArtifactRevision,
  getActiveModelVersion,
}: UseEngineRunnerOptions) {
  const engineWorkerRef = useRef<Worker | null>(null);
  const engineRequestIdRef = useRef(0);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>('idle');
  const [engineMessage, setEngineMessage] = useState(
    'Select a meeting and run the engine.',
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

  function disposeEngineWorker(): void {
    engineWorkerRef.current?.terminate();
    engineWorkerRef.current = null;
  }

  function resetEngineSelection(): void {
    setEngineMessage('Select a meeting and run the engine.');
  }

  function openLogging(mode: 'engine' | 'transcription'): void {
    setEngineDialogMode(mode);
    setEngineDialogOpen(true);
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

  async function runTranscription(meetingId: string = selectedMeetingId) {
    const repo = meetingsRepoRef.current;
    const selectedMeeting = meetings.find((meeting) => meeting.id === meetingId);
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
      await repo.deleteArtifact(selectedMeeting.id, 'transcript');
      await repo.deleteArtifact(selectedMeeting.id, 'word-sync');
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
        const handleMessage = (event: MessageEvent<EngineWorkerResponse>) => {
          const msg = event.data;

          if (msg.id !== requestId) return;
          if (handleWorkerUpdate(msg)) return;
          if (msg.type !== 'result') return;

          worker.removeEventListener('message', handleMessage);

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
          languageMode: selectedMeeting.languageMode ?? 'auto-once',
        };
        appendEngineLog(
          `[worker] posting transcription request ${requestId} with ${sampleCount} samples (${sampleDurationSeconds.toFixed(3)}s).`,
        );
        worker.postMessage(request, [samples.buffer]);
        appendEngineLog(`[worker] posted transcription request ${requestId}.`);
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

  async function runDiarization(meetingId: string = selectedMeetingId) {
    const repo = meetingsRepoRef.current;
    const selectedMeeting = meetings.find((meeting) => meeting.id === meetingId);

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
        const handleMessage = (event: MessageEvent<EngineWorkerResponse>) => {
          const msg = event.data;

          if (msg.id !== requestId) return;
          if (msg.type === 'live-transcript') return;
          if (handleWorkerUpdate(msg)) return;
          if (msg.type !== 'result') return;

          worker.removeEventListener('message', handleMessage);

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
          numSpeakers: selectedMeeting.participantCount,
        };
        appendEngineLog(
          `[worker] posting diarization request ${requestId} with ${sampleCount} samples (${sampleDurationSeconds.toFixed(3)}s).`,
        );
        worker.postMessage(request, [samples.buffer]);
        appendEngineLog(`[worker] posted diarization request ${requestId}.`);
      });

      const normalizedTurns = renumberSpeakersSequentially(turns);

      await repo.saveArtifact(selectedMeeting.id, 'diarization', normalizedTurns);
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

  async function runWordSync(meetingId: string) {
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

    const activeWav2Vec2 = getActiveModelVersion('text-audio-sync');

    if (activeWav2Vec2 === undefined) {
      setEngineMessage('Download a Wav2Vec2 model first.');
      return;
    }

    setEngineStatus('processing');
    setLiveTranscriptMeetingId(null);
    setEngineMessage(`Aligning words for ${meeting.name}...`);
    setEngineLog([
      `Starting word-sync for ${meeting.name}.`,
      `Using Wav2Vec2 ${getModelVersionTitle(activeWav2Vec2)}.`,
    ]);

    try {
      await repo.deleteArtifact(meetingId, 'word-sync');
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
        const handleMessage = (event: MessageEvent<EngineWorkerResponse>) => {
          const msg = event.data;
          if (msg.id !== requestId) return;
          if (handleWorkerUpdate(msg)) return;
          if (msg.type !== 'result') return;
          worker.removeEventListener('message', handleMessage);
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
          transcript,
        };
        worker.postMessage(request, [samples.buffer]);
      });

      await repo.saveArtifact(meetingId, 'word-sync', words);
      await refreshMeetings(repo);
      setArtifactRevision((current) => current + 1);
      setEngineStatus('idle');
      setEngineMessage(
        `Word sync completed for ${meeting.name} (${words.length} words).`,
      );
    } catch (error) {
      setEngineStatus('error');
      const message = error instanceof Error ? error.message : 'Word sync failed.';
      setEngineMessage(message);
      appendEngineLog(`[error] ${message}`);
      console.error('[engine] word sync failed', error);
    }
  }

  async function runSpeakerNaming(meetingId: string) {
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
          const handleMessage = (event: MessageEvent<EngineWorkerResponse>) => {
            const msg = event.data;
            if (msg.id !== requestId) return;
            if (handleWorkerUpdate(msg)) return;
            if (msg.type !== 'result') return;
            worker.removeEventListener('message', handleMessage);
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
            transcript,
            diarization: turns,
          };
          worker.postMessage(request, [samples.buffer]);
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

  return {
    engineStatus,
    engineMessage,
    engineDialogOpen,
    engineDialogMode,
    engineLog,
    liveTranscriptSegments,
    liveTranscriptMeetingId,
    setEngineDialogOpen,
    resetEngineSelection,
    openLogging,
    disposeEngineWorker,
    runTranscription,
    runDiarization,
    runWordSync,
    runSpeakerNaming,
  };
}

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

    const offlineContext = new OfflineAudioContext(1, frameCount, targetSampleRate);
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

function getWhisperRuntimeLabel(version: ModelVersionManifestEntry): string {
  const quantization =
    version.quantization ?? version.metadata?.['quantization'];

  return typeof quantization === 'string' && quantization.length > 0
    ? `auto device with ${quantization} quantization from the active Whisper model`
    : 'auto device with quantization from the active Whisper model';
}
