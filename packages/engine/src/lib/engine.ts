import type { EngineDependencies } from './engine-dependencies';
import type { ProcessMeetingOptions } from './process-meeting-options';
import type { SpeakerNameGuess } from './speaker-name-guess';
import type { Meeting } from './models/meeting';
import type { MeetingNotes } from './models/meeting-notes';
import type { SpeakerTurn } from './models/speaker-turn';
import type { TranscriptSegment } from './models/transcript-segment';

export class Engine {
  readonly transcription: EngineDependencies['transcription'];
  readonly diarization: EngineDependencies['diarization'];
  readonly speakerNaming: EngineDependencies['speakerNaming'];

  constructor(dependencies: EngineDependencies) {
    this.transcription = dependencies.transcription;
    this.diarization = dependencies.diarization;
    this.speakerNaming = dependencies.speakerNaming;
  }

  async processMeeting(
    meeting: Meeting,
    options: ProcessMeetingOptions = {},
  ): Promise<MeetingNotes> {
    const onProgress = options.onProgress ?? (() => undefined);

    onProgress({ stage: 'transcription', status: 'started' });
    onProgress({ stage: 'diarization', status: 'started' });
    const [transcript, speakerTurns] = await Promise.all([
      this.transcription.transcribe(meeting).then((result) => {
        onProgress({ stage: 'transcription', status: 'completed' });
        return result;
      }),
      this.diarization.diarize(meeting).then((result) => {
        onProgress({ stage: 'diarization', status: 'completed' });
        return result;
      }),
    ]);
    const normalizedSpeakerTurns = this.#normalizeSpeakerTurns(speakerTurns);
    const segments = transcript.segments.map((segment) => ({
      ...segment,
      speaker: this.#findSpeakerForSegment(segment, normalizedSpeakerTurns),
    }));
    const speakers = [...new Set(segments.map((segment) => segment.speaker))];
    onProgress({ stage: 'speaker-naming', status: 'started' });
    const speakerNames = this.#resolveSpeakerNames(
      speakers,
      await this.speakerNaming.nameSpeakers({
        meeting,
        transcript: transcript.text,
        segments,
        speakers,
      }),
    );
    onProgress({ stage: 'speaker-naming', status: 'completed' });

    return {
      meeting,
      transcript,
      speakerTurns: normalizedSpeakerTurns,
      speakerNames,
      segments: segments.map((segment) => ({
        ...segment,
        speakerName: speakerNames[segment.speaker] ?? segment.speaker,
      })),
    };
  }

  #normalizeSpeakerTurns(speakerTurns: SpeakerTurn[]): SpeakerTurn[] {
    const speakerLabels = new Map<string, string>();

    return [...speakerTurns]
      .sort((first, second) => first.startSeconds - second.startSeconds)
      .map((turn) => {
        let label = speakerLabels.get(turn.speaker);

        if (label === undefined) {
          label = `Speaker ${speakerLabels.size + 1}`;
          speakerLabels.set(turn.speaker, label);
        }

        return {
          ...turn,
          speaker: label,
        };
      });
  }

  #findSpeakerForSegment(segment: TranscriptSegment, speakerTurns: SpeakerTurn[]): string {
    let bestTurn: SpeakerTurn | undefined;
    let bestOverlapSeconds = 0;

    for (const turn of speakerTurns) {
      const overlapSeconds = Math.max(
        0,
        Math.min(segment.endSeconds, turn.endSeconds) - Math.max(segment.startSeconds, turn.startSeconds),
      );

      if (overlapSeconds > bestOverlapSeconds) {
        bestTurn = turn;
        bestOverlapSeconds = overlapSeconds;
      }
    }

    return bestTurn?.speaker ?? 'Speaker 1';
  }

  #resolveSpeakerNames(speakers: string[], guesses: SpeakerNameGuess[]): Record<string, string> {
    const names = Object.fromEntries(speakers.map((speaker) => [speaker, speaker]));

    for (const guess of guesses) {
      const name = guess.name?.trim();

      if (name !== undefined && name.length > 0 && speakers.includes(guess.speaker)) {
        names[guess.speaker] = name;
      }
    }

    return names;
  }
}
