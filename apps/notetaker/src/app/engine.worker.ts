/// <reference lib="webworker" />
import {
    Engine, PipelineFactory, EngineProgressEvent, MeetingNotes, SpeakerTurn, Transcript, configureTransformersCache,
    TimestampedWord
} from '@notetaker/engine';
import {FileSystem, type LanguageMode} from '@notetaker/filesystem';
import {ModelManager} from '@notetaker/model-manager';

interface WorkerTranscriptSegment {
    text: string;
    startSeconds: number;
    endSeconds: number;
}

interface TimestampedText {
    timestampInMs: number;
    text: string;
}

function estimateFragmentEndSeconds(
    startSeconds: number,
    text: string,
): number {
    const wordCount = text.split(/\s+/).filter(Boolean).length;

    return startSeconds + Math.max(1, wordCount * 0.45);
}

function findSpeakerForRange(
    startSeconds: number,
    endSeconds: number,
    turns: SpeakerTurn[],
): string {
    let bestTurn: SpeakerTurn | undefined;
    let bestOverlap = 0;

    for (const turn of turns) {
        const overlap = Math.max(
            0,
            Math.min(endSeconds, turn.endSeconds) -
            Math.max(startSeconds, turn.startSeconds),
        );

        if (overlap > bestOverlap) {
            bestTurn = turn;
            bestOverlap = overlap;
        }
    }

    return bestTurn?.speaker ?? 'SPEAKER_0';
}

function toWorkerTranscriptSegments(
    fragments: TimestampedText[],
): WorkerTranscriptSegment[] {
    return fragments.map((fragment, index) => {
        const nextFragment = fragments[index + 1];
        const startSeconds = fragment.timestampInMs / 1000;

        return {
            text: fragment.text,
            startSeconds,
            endSeconds:
                nextFragment?.timestampInMs !== undefined
                    ? nextFragment.timestampInMs / 1000
                    : estimateFragmentEndSeconds(startSeconds, fragment.text),
        };
    });
}

export interface EngineWorkerRequest {
    id: number;
    mode?:
        | 'engine'
        | 'transcription'
        | 'diarization'
        | 'word-sync'
        | 'speaker-naming'
        | 'detect-language';
    fileName: string;
    audio: Float32Array;
    audioSampleRate?: number;
    numSpeakers?: number | null;
    transcript?: Transcript;
    diarization?: SpeakerTurn[];
    language?: string;
    languageMode?: LanguageMode;
}

export type EngineWorkerResponse =
    | { id: number; type: 'progress'; event: EngineProgressEvent }
    | { id: number; type: 'log'; line: string }
    | { id: number; type: 'bar'; value: number | null }
    | {
    id: number;
    type: 'live-transcript';
    text: string;
    segments: WorkerTranscriptSegment[];
}
    | {
    id: number;
    type: 'result';
    ok: true;
    mode: 'engine';
    notes: MeetingNotes;
}
    | {
    id: number;
    type: 'result';
    ok: true;
    mode: 'transcription';
    transcript: Transcript;
}
    | {
    id: number;
    type: 'result';
    ok: true;
    mode: 'diarization';
    turns: SpeakerTurn[];
}
    | {
    id: number;
    type: 'result';
    ok: true;
    mode: 'word-sync';
    words: TimestampedWord[];
}
    | {
    id: number;
    type: 'result';
    ok: true;
    mode: 'speaker-naming';
    names: Record<string, string>;
}
    | {
    id: number;
    type: 'result';
    ok: true;
    mode: 'detect-language';
    language: string | null;
}
    | { id: number; type: 'result'; ok: false; error: string };

let modelManagerPromise: Promise<ModelManager> | null = null;

console.log('[engine-worker] module initialized');

function getModelManager(): Promise<ModelManager> {
    if (modelManagerPromise === null) {
        modelManagerPromise = ModelManager.create(new FileSystem());
    }

    return modelManagerPromise;
}

self.addEventListener('message', (event: MessageEvent<EngineWorkerRequest>) => {
    const {
        id,
        mode = 'engine',
        fileName,
        audio,
        numSpeakers = null,
    } = event.data;

    void (async () => {
        const log = (line: string) => {
            const message: EngineWorkerResponse = {id, type: 'log', line};
            (self as DedicatedWorkerGlobalScope).postMessage(message);
        };
        try {
            const modelManager = await getModelManager();
            configureTransformersCache(modelManager);
            log(
                `[runtime] crossOriginIsolated=${globalThis.crossOriginIsolated}; hardwareConcurrency=${navigator.hardwareConcurrency ?? 'unknown'}`,
            );
            const engine = new Engine(new PipelineFactory(), modelManager);

            if (mode === 'detect-language') {
                const progress: EngineWorkerResponse = {
                    id,
                    type: 'progress',
                    event: {stage: 'transcription', status: 'started'},
                };
                (self as DedicatedWorkerGlobalScope).postMessage(progress);
                log(
                    `[language-detection] worker received ${audio.length} samples for ${fileName}.`,
                );
                const language = await engine.detectAudioLanguage(audio, {
                    debug: log,
                });
                log(`[language-detection] worker resolved language=${language ?? 'null'}.`);
                const completed: EngineWorkerResponse = {
                    id,
                    type: 'progress',
                    event: {stage: 'transcription', status: 'completed'},
                };
                (self as DedicatedWorkerGlobalScope).postMessage(completed);
                const response: EngineWorkerResponse = {
                    id,
                    type: 'result',
                    ok: true,
                    mode: 'detect-language',
                    language,
                };
                (self as DedicatedWorkerGlobalScope).postMessage(response);
                return;
            }

            if (mode === 'transcription') {
                const fragments: TimestampedText[] = [];
                const progress: EngineWorkerResponse = {
                    id,
                    type: 'progress',
                    event: {stage: 'transcription', status: 'started'},
                };
                (self as DedicatedWorkerGlobalScope).postMessage(progress);
                log(
                    `[transcription] worker received ${audio.length} samples for ${fileName}.`,
                );
                const languageMode: LanguageMode =
                    event.data.languageMode ?? 'auto-once';
                let language = event.data.language;
                let task: 'transcribe' | 'translate' | undefined;
                if (languageMode === 'translate') {
                    log('[language-mode] translate selected; transcribing to English.');
                    task = 'translate';
                    language = undefined;
                } else if (language === undefined) {
                    if (languageMode === 'auto-per-chunk') {
                        log(
                            '[language-mode] auto-per-chunk not yet implemented; falling back to auto-once.',
                        );
                    }
                    log('[language-detection] running detection before transcription...');
                    const detected = await engine.detectAudioLanguage(audio, {
                        debug: log,
                    });
                    if (detected !== null) {
                        language = detected;
                        log(`[language-detection] using detected language '${detected}'.`);
                    } else {
                        log(
                            '[language-detection] no language detected; transcription will fall back to default.',
                        );
                    }
                }
                const transcriptText = await engine.transcribeAudio(
                    audio,
                    (updates) => {
                        log(
                            `[transcription] worker received ${updates.length} fragment update(s).`,
                        );
                        fragments.splice(0, fragments.length, ...updates);
                        const segments = toWorkerTranscriptSegments(fragments);
                        const message: EngineWorkerResponse = {
                            id,
                            type: 'live-transcript',
                            text: fragments.map((fragment) => fragment.text).join(' '),
                            segments,
                        };
                        (self as DedicatedWorkerGlobalScope).postMessage(message);
                    },
                    log,
                    language,
                    task,
                );
                log(
                    `[transcription] worker completed with transcript length=${transcriptText.length}; fragments=${fragments.length}.`,
                );
                const completed: EngineWorkerResponse = {
                    id,
                    type: 'progress',
                    event: {stage: 'transcription', status: 'completed'},
                };
                (self as DedicatedWorkerGlobalScope).postMessage(completed);
                // For 'translate' the output is always English; otherwise it's
                // whatever language Whisper transcribed in (explicit or detected).
                const transcriptLanguage =
                    task === 'translate' ? 'en' : language;
                const response: EngineWorkerResponse = {
                    id,
                    type: 'result',
                    ok: true,
                    mode: 'transcription',
                    transcript: {
                        text: transcriptText,
                        segments: toWorkerTranscriptSegments(fragments).map((segment) => ({
                            ...segment,
                            speaker: 'SPEAKER_0',
                            speakerName: 'SPEAKER_0',
                        })),
                        ...(transcriptLanguage !== undefined
                            ? { language: transcriptLanguage }
                            : {}),
                    },
                };
                (self as DedicatedWorkerGlobalScope).postMessage(response);
                return;
            }

            if (mode === 'word-sync') {
                const transcript = event.data.transcript;
                if (transcript === undefined) {
                    throw new Error('word-sync requires a transcript.');
                }
                const progress: EngineWorkerResponse = {
                    id,
                    type: 'progress',
                    event: {stage: 'word-sync', status: 'started'},
                };
                (self as DedicatedWorkerGlobalScope).postMessage(progress);
                const words = await engine.alignTranscriptToAudio(
                    transcript,
                    audio,
                    log,
                    event.data.audioSampleRate,
                );
                log(
                    `[word-sync] aligned ${words.length} word timestamp(s) over ${transcript.segments.length} transcript segment(s).`,
                );
                const completed: EngineWorkerResponse = {
                    id,
                    type: 'progress',
                    event: {stage: 'word-sync', status: 'completed'},
                };
                (self as DedicatedWorkerGlobalScope).postMessage(completed);
                const response: EngineWorkerResponse = {
                    id,
                    type: 'result',
                    ok: true,
                    mode: 'word-sync',
                    words: words.map((w) => ({
                        word: w.word,
                        timestampInMs: w.timestampInMs,
                        endTimeInMs: w.endTimeInMs,
                    })),
                };
                (self as DedicatedWorkerGlobalScope).postMessage(response);
                return;
            }

            if (mode === 'speaker-naming') {
                const transcript = event.data.transcript;
                const turns = event.data.diarization;
                if (transcript === undefined || turns === undefined) {
                    throw new Error(
                        'speaker-naming requires a transcript and diarization.',
                    );
                }
                const progress: EngineWorkerResponse = {
                    id,
                    type: 'progress',
                    event: {stage: 'speaker-naming', status: 'started'},
                };
                (self as DedicatedWorkerGlobalScope).postMessage(progress);

                const segments = transcript.segments.map((segment) => ({
                    text: segment.text,
                    startSeconds: segment.startSeconds,
                    endSeconds: segment.endSeconds,
                    speaker: findSpeakerForRange(
                        segment.startSeconds,
                        segment.endSeconds,
                        turns,
                    ),
                }));

                const namesMap = await engine.nameSpeakers(
                    {id: fileName, title: fileName, audio},
                    segments,
                );

                const completed: EngineWorkerResponse = {
                    id,
                    type: 'progress',
                    event: {stage: 'speaker-naming', status: 'completed'},
                };
                (self as DedicatedWorkerGlobalScope).postMessage(completed);
                const response: EngineWorkerResponse = {
                    id,
                    type: 'result',
                    ok: true,
                    mode: 'speaker-naming',
                    names: Object.fromEntries(namesMap),
                };
                (self as DedicatedWorkerGlobalScope).postMessage(response);
                return;
            }

            if (mode === 'diarization') {
                const progress: EngineWorkerResponse = {
                    id,
                    type: 'progress',
                    event: {stage: 'diarization', status: 'started'},
                };
                (self as DedicatedWorkerGlobalScope).postMessage(progress);
                const turns = await engine.diarizeAudio(audio, {
                    speakerCountHint: numSpeakers,
                    debug: log,
                });
                const completed: EngineWorkerResponse = {
                    id,
                    type: 'progress',
                    event: {stage: 'diarization', status: 'completed'},
                };
                (self as DedicatedWorkerGlobalScope).postMessage(completed);
                const response: EngineWorkerResponse = {
                    id,
                    type: 'result',
                    ok: true,
                    mode: 'diarization',
                    turns,
                };
                (self as DedicatedWorkerGlobalScope).postMessage(response);
                return;
            }

            const notes = await engine.processMeeting(
                {
                    id: fileName,
                    title: fileName,
                    audio,
                },
                {
                    onProgress: (event) => {
                        const progress: EngineWorkerResponse = {
                            id,
                            type: 'progress',
                            event,
                        };
                        (self as DedicatedWorkerGlobalScope).postMessage(progress);
                    },
                    onDebug: log,
                    onPartialTranscript: (fragments) => {
                        log(
                            `[transcription] worker received ${fragments.length} partial fragment update(s).`,
                        );
                        const segments = toWorkerTranscriptSegments(fragments);
                        const message: EngineWorkerResponse = {
                            id,
                            type: 'live-transcript',
                            text: fragments.map((fragment) => fragment.text).join(' '),
                            segments,
                        };
                        (self as DedicatedWorkerGlobalScope).postMessage(message);
                    },
                    speakerCountHint: numSpeakers,
                },
            );
            const sanitized: MeetingNotes = {
                ...notes,
                meeting: {...notes.meeting, audio: new Uint8Array(0)},
            };
            const response: EngineWorkerResponse = {
                id,
                type: 'result',
                ok: true,
                mode: 'engine',
                notes: sanitized,
            };
            (self as DedicatedWorkerGlobalScope).postMessage(response);
        } catch (error) {
            const response: EngineWorkerResponse = {
                id,
                type: 'result',
                ok: false,
                error:
                    error instanceof Error ? error.message : 'Engine processing failed.',
            };
            (self as DedicatedWorkerGlobalScope).postMessage(response);
        }
    })();
});
