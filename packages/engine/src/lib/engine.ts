export type MeetingAudio = Blob | ArrayBuffer | Uint8Array;

export interface Meeting {
  audio: MeetingAudio;
  id?: string;
  title?: string;
  startedAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface TranscriptSegment {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
}

export interface SpeakerTurn {
  speaker: string;
  startSeconds: number;
  endSeconds: number;
}

export interface SpeakerTranscriptSegment extends TranscriptSegment {
  speaker: string;
  speakerName: string;
}

export interface SpeakerNameGuess {
  speaker: string;
  name: string | null | undefined;
}

export interface MeetingNotes {
  meeting: Meeting;
  transcript: Transcript;
  speakerTurns: SpeakerTurn[];
  speakerNames: Record<string, string>;
  segments: SpeakerTranscriptSegment[];
}

export interface TranscriptionEngine {
  transcribe(meeting: Meeting): Promise<Transcript>;
}

export interface SpeakerDiarizationEngine {
  diarize(meeting: Meeting): Promise<SpeakerTurn[]>;
}

export interface SpeakerNamingModel {
  nameSpeakers(input: SpeakerNamingInput): Promise<SpeakerNameGuess[]>;
}

export interface SpeakerNamingInput {
  meeting: Meeting;
  transcript: string;
  segments: Omit<SpeakerTranscriptSegment, 'speakerName'>[];
  speakers: string[];
}

export interface EngineDependencies {
  transcription: TranscriptionEngine;
  diarization: SpeakerDiarizationEngine;
  speakerNaming: SpeakerNamingModel;
}

export class Engine {
  readonly transcription: TranscriptionEngine;
  readonly diarization: SpeakerDiarizationEngine;
  readonly speakerNaming: SpeakerNamingModel;

  constructor(dependencies: EngineDependencies) {
    this.transcription = dependencies.transcription;
    this.diarization = dependencies.diarization;
    this.speakerNaming = dependencies.speakerNaming;
  }

  async processMeeting(meeting: Meeting): Promise<MeetingNotes> {
    const [transcript, speakerTurns] = await Promise.all([
      this.transcription.transcribe(meeting),
      this.diarization.diarize(meeting),
    ]);
    const normalizedSpeakerTurns = this.#normalizeSpeakerTurns(speakerTurns);
    const segments = transcript.segments.map((segment) => ({
      ...segment,
      speaker: this.#findSpeakerForSegment(segment, normalizedSpeakerTurns),
    }));
    const speakers = [...new Set(segments.map((segment) => segment.speaker))];
    const speakerNames = this.#resolveSpeakerNames(
      speakers,
      await this.speakerNaming.nameSpeakers({
        meeting,
        transcript: transcript.text,
        segments,
        speakers,
      }),
    );

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
