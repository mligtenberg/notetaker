import type { ProcessMeetingOptions } from './process-meeting-options';
import type { Meeting } from './models/meeting';
import type { MeetingNotes } from './models/meeting-notes';
import type { MeetingAudio } from './models/meeting-audio';
import type { SpeakerTurn } from './models/speaker-turn';
import type { TranscriptSegment } from './models/transcript-segment';
import type { TimestampedText } from './models/timestamped-text';
import type { Transcript } from './models/transcript';
import type { TimestampedWord } from './models/timestamped-word';
import { PipelineFactory } from './pipeline-factory';
import { ModelManager } from '@notetaker/model-manager';
import { TranscriptionService } from './transcription-service';
import { DiarizationService } from './diarization-service';
import { AlignmentService } from './alignment-service';
import { SpeakerNamingService } from './speaker-naming-service';

export class Engine {
  private transcriptionService: TranscriptionService;
  private diarizationService: DiarizationService;
  private alignmentService: AlignmentService;
  private speakerNamingService: SpeakerNamingService;

  constructor(
    pipelineFactory: PipelineFactory,
    modelManager: ModelManager,
  ) {
    this.transcriptionService = new TranscriptionService(
      pipelineFactory,
      modelManager,
    );
    this.diarizationService = new DiarizationService(modelManager);
    this.alignmentService = new AlignmentService(modelManager);
    this.speakerNamingService = new SpeakerNamingService(
      pipelineFactory,
      modelManager,
    );
  }

  async processMeeting(
    meeting: Meeting,
    options: ProcessMeetingOptions = {},
  ): Promise<MeetingNotes> {
    const emit = options.onProgress;
    const debug = options.onDebug;
    const timestampedFragments: TimestampedText[] = [];

    emit?.({ stage: 'transcription', status: 'started' });
    const transcriptText = await this.transcriptionService.transcribeAudio(
      meeting.audio,
      {
        fragmentCallback: (fragments) => {
          timestampedFragments.splice(
            0,
            timestampedFragments.length,
            ...fragments,
          );
          options.onPartialTranscript?.(timestampedFragments);
        },
        debug,
      },
    );
    emit?.({ stage: 'transcription', status: 'completed' });

    emit?.({ stage: 'diarization', status: 'started' });
    const speakerTurns = await this.diarizationService.diarizeAudio(
      meeting.audio,
      {
        speakerCountHint: options.speakerCountHint,
        debug,
      },
    );
    const alignedWords = await this.alignmentService.alignTranscriptToAudio(
      buildTranscriptFromFragments(transcriptText, timestampedFragments),
      meeting.audio,
      debug,
    );
    emit?.({ stage: 'diarization', status: 'completed' });

    const segments = this.#buildSegments(
      transcriptText,
      timestampedFragments,
      alignedWords,
      speakerTurns,
    );

    emit?.({ stage: 'speaker-naming', status: 'started' });
    const speakerNames = await this.speakerNamingService.nameSpeakers(
      meeting,
      segments,
    );
    emit?.({ stage: 'speaker-naming', status: 'completed' });

    return {
      meeting,
      transcript: {
        text: transcriptText,
        segments: segments.map((segment) => ({
          ...segment,
          speakerName: speakerNames.get(segment.speaker) ?? segment.speaker,
        })),
      },
    };
  }

  async detectAudioLanguage(
    meetingAudio: MeetingAudio,
    options: { sampleSeconds?: number; debug?: (line: string) => void } = {},
  ): Promise<string | null> {
    return this.transcriptionService.detectAudioLanguage(meetingAudio, options);
  }

  async transcribeAudio(
    meetingAudio: MeetingAudio,
    fragmentCallback: (fragments: TimestampedText[]) => void,
    debug?: (line: string) => void,
    language?: string,
    task?: 'transcribe' | 'translate',
  ): Promise<string> {
    return this.transcriptionService.transcribeAudio(meetingAudio, {
      fragmentCallback,
      debug,
      language,
      task,
    });
  }

  async diarizeAudio(
    meetingAudio: MeetingAudio,
    options: { speakerCountHint?: number | null; debug?: (line: string) => void } = {},
  ): Promise<SpeakerTurn[]> {
    return this.diarizationService.diarizeAudio(meetingAudio, options);
  }

  async alignTranscriptToAudio(
    transcript: Transcript,
    meetingAudio: MeetingAudio,
    debug?: (line: string) => void,
    inputSampleRate?: number,
  ): Promise<TimestampedWord[]> {
    return this.alignmentService.alignTranscriptToAudio(
      transcript,
      meetingAudio,
      debug,
      inputSampleRate,
    );
  }

  async nameSpeakers(
    meeting: Meeting,
    segments: Omit<TranscriptSegment, 'speakerName'>[],
  ): Promise<Map<string, string>> {
    return this.speakerNamingService.nameSpeakers(meeting, segments);
  }

  #buildSegments(
    transcript: string,
    fragments: TimestampedText[],
    alignedWords: TimestampedWord[],
    speakerTurns: SpeakerTurn[],
  ): Omit<TranscriptSegment, 'speakerName'>[] {
    const sourceFragments =
      fragments.length > 0
        ? fragments
        : alignedWords.map((word) => ({
            timestampInMs: word.timestampInMs,
            text: word.word,
          }));

    return sourceFragments.map((fragment, index) => {
      const nextFragment = sourceFragments[index + 1];
      const startSeconds = fragment.timestampInMs / 1000;
      const endSeconds =
        nextFragment?.timestampInMs !== undefined
          ? nextFragment.timestampInMs / 1000
          : this.#estimateFragmentEndSeconds(startSeconds, fragment.text);
      const speaker = this.#findSpeakerForRange(
        startSeconds,
        endSeconds,
        speakerTurns,
      );

      return {
        text: fragment.text,
        startSeconds,
        endSeconds,
        speaker,
      };
    });
  }

  #estimateFragmentEndSeconds(startSeconds: number, text: string): number {
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    return startSeconds + Math.max(1, wordCount * 0.45);
  }

  #findSpeakerForRange(
    startSeconds: number,
    endSeconds: number,
    speakerTurns: SpeakerTurn[],
  ): string {
    let bestTurn: SpeakerTurn | undefined;
    let bestOverlap = 0;

    for (const turn of speakerTurns) {
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
}

function buildTranscriptFromFragments(
  text: string,
  fragments: TimestampedText[],
): Transcript {
  const segments = fragments.map((fragment, index) => {
    const next = fragments[index + 1];
    const startSeconds = fragment.timestampInMs / 1000;
    const wordCount = fragment.text.split(/\s+/).filter(Boolean).length;
    const endSeconds =
      next?.timestampInMs !== undefined
        ? next.timestampInMs / 1000
        : startSeconds + Math.max(1, wordCount * 0.45);

    return {
      text: fragment.text,
      startSeconds,
      endSeconds,
      speaker: '',
      speakerName: '',
    };
  });

  return { text, segments };
}
