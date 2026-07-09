import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { SpeakerTurn, Transcript } from '@notetaker/engine';
import type { MeetingDerivationKind } from '@notetaker/filesystem';
import styles from '../../../app.module.css';
import { ExportControls } from '../export-controls';
import {
  RecordingPlayback,
  SpeakerContextMenu,
  WordAssignmentPopover,
  clampBoundarySeconds,
  collectSpeakers,
  displaySpeakerName,
  mergeAdjacentSpeakerTurns,
  mergeSpeakerTurns,
  openSpeakerContextMenu,
  openWordAssignmentPopover,
  playRecordingFrom,
  rangesOverlap,
  saveSpeakerNameArtifact,
} from './shared';
import type {
  MediaElementRef,
  SpeakerContextMenuState,
  SpeakerWordTurn,
  TimestampedWord,
  WordAssignmentPopoverState,
} from './types';

interface WordSyncArtifactTabProps {
  meetingId: string;
  meetingName: string;
  meetingUrl: string | undefined;
  audioRef: MediaElementRef;
  recordingMimeType: string | null;
  present: boolean;
  revision: number;
  loadDerivation: <U>(
    meetingId: string,
    kind: MeetingDerivationKind,
  ) => Promise<U | null>;
  saveDerivation: <U>(
    meetingId: string,
    kind: MeetingDerivationKind,
    data: U,
  ) => Promise<void>;
  onSpeakerNamesSaved: () => void;
  formatTimestamp: (seconds: number) => string;
}

export function WordSyncArtifactTab({
  meetingId,
  meetingName,
  meetingUrl,
  audioRef,
  recordingMimeType,
  present,
  revision,
  loadDerivation,
  saveDerivation,
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
  const activeWord =
    words !== null ? getActiveWord(words, currentPlaybackTime) : null;

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
  }, [activeWord]);

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
      loadDerivation<TimestampedWord[]>(meetingId, 'word-sync'),
      loadDerivation<SpeakerTurn[]>(meetingId, 'diarization'),
      loadDerivation<Record<string, string>>(meetingId, 'speaker-names'),
    ])
      .then(([words, diarization, speakerNames]) => {
        if (cancelled) {
          return;
        }

        if (words === null || diarization === null) {
          throw new Error('Word sync or diarization artifact missing.');
        }

        // getActiveWord relies on start-time order; turns must share the same
        // word instances so the active word can be found by reference.
        const sortedWords = [...words].sort(
          (first, second) => first.timestampInMs - second.timestampInMs,
        );

        setWords(sortedWords);
        setDiarization(diarization);
        setTurns(buildSpeakerWordTurns(sortedWords, diarization));
        setSpeakerNames(speakerNames ?? {});
        setWordCount(sortedWords.length);
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
  }, [meetingId, present, revision, loadDerivation]);

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

              await saveDerivation(meetingId, 'diarization', alignedDiarization);
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
                loadDerivation,
                saveDerivation,
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

              await saveDerivation(meetingId, 'diarization', mergedDiarization);
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
              const transcript = await loadDerivation<Transcript>(
                meetingId,
                'transcript',
              );

              await saveDerivation(meetingId, 'word-sync', nextWords);
              if (transcript !== null) {
                await saveDerivation(
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

            await saveDerivation(meetingId, 'diarization', adjustedDiarization);
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

            await saveDerivation(meetingId, 'diarization', adjustedDiarization);
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
                      active={word === activeWord}
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

// The active word is the word whose own span contains the playhead; during
// gaps (silence, music) no word is active. `words` must be sorted by start
// time — when stale data has overlapping spans, the latest-starting one wins.
function getActiveWord(
  words: TimestampedWord[],
  currentPlaybackTime: number,
): TimestampedWord | null {
  const currentTimeInMs = currentPlaybackTime * 1000;
  let activeWord: TimestampedWord | null = null;

  for (const word of words) {
    if (word.timestampInMs > currentTimeInMs) {
      break;
    }

    if (currentTimeInMs < word.endTimeInMs) {
      activeWord = word;
    }
  }

  return activeWord;
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
  const replacementWords = nextWords.map((word, index) => {
    const startInMs =
      turn.words[index]?.timestampInMs ??
      interpolateWordTimestampInMs(turn, index, nextWords.length);
    const nextStartInMs =
      turn.words[index + 1]?.timestampInMs ??
      (index + 1 < nextWords.length
        ? interpolateWordTimestampInMs(turn, index + 1, nextWords.length)
        : Math.round(turn.endSeconds * 1000));
    const endInMs =
      turn.words[index]?.endTimeInMs ?? Math.max(startInMs, nextStartInMs);

    return {
      word,
      timestampInMs: startInMs,
      endTimeInMs: endInMs,
    };
  });

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
