import type { Meeting } from './models/meeting';
import type { TranscriptSegment } from './models/transcript-segment';
import { PipelineFactory } from './pipeline-factory';
import { ModelManager } from '@notetaker/model-manager';
import type { CallablePipeline } from './model-utils';
import { requireActiveModel, isModelSessionError } from './model-utils';

const SPEAKER_NAMING_SEGMENT_CHUNK_SIZE = 50;
const SPEAKER_NAMING_SEGMENT_CHUNK_OVERLAP = 3;

export class SpeakerNamingService {
  constructor(
    private pipelineFactory: PipelineFactory,
    private modelManager: ModelManager,
  ) {}

  async nameSpeakers(
    meeting: Meeting,
    segments: Omit<TranscriptSegment, 'speakerName'>[],
  ): Promise<Map<string, string>> {
    const speakers = [...new Set(segments.map((segment) => segment.speaker))];

    if (speakers.length === 0) {
      return new Map();
    }

    const activeModel = await requireActiveModel(
      this.modelManager,
      'language',
    );

    try {
      const pipeline = (await this.pipelineFactory.getPipeline(
        activeModel.manifest,
      )) as CallablePipeline;
      const parsed = new Map<string, string>();
      const chunkStep =
        SPEAKER_NAMING_SEGMENT_CHUNK_SIZE -
        SPEAKER_NAMING_SEGMENT_CHUNK_OVERLAP;

      for (
        let startIndex = 0;
        startIndex < segments.length;
        startIndex += chunkStep
      ) {
        const remainingSpeakers = speakers.filter(
          (speaker) => !parsed.has(speaker),
        );

        if (remainingSpeakers.length === 0) {
          break;
        }

        const chunk = segments.slice(
          startIndex,
          startIndex + SPEAKER_NAMING_SEGMENT_CHUNK_SIZE,
        );
        const chunkSpeakers = remainingSpeakers.filter((speaker) =>
          chunk.some((segment) => segment.speaker === speaker),
        );

        if (chunkSpeakers.length === 0) {
          continue;
        }

        const result = (await pipeline(
          createSpeakerNamingPrompt(
            meeting,
            chunk,
            chunkSpeakers,
            parsed,
          ),
          {
            max_new_tokens: 256,
            return_full_text: false,
          },
        )) as TextGenerationResult;
        const text = getGeneratedText(result);
        const chunkParsed = parseSpeakerNames(text);
        for (const [speaker, name] of chunkParsed) {
          if (!parsed.has(speaker)) {
            parsed.set(speaker, name);
          }
        }
      }

      return new Map(
        speakers.map((speaker) => [speaker, parsed.get(speaker) ?? speaker]),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'Not supported in pipelines' ||
          isModelSessionError(error))
      ) {
        return new Map(speakers.map((speaker) => [speaker, speaker]));
      }

      throw error;
    }
  }
}

type TextGenerationResult =
  | string
  | { generated_text?: string }
  | { generated_text?: string }[];

function createSpeakerNamingPrompt(
  meeting: Meeting,
  segments: Omit<TranscriptSegment, 'speakerName'>[],
  speakers: string[],
  knownSpeakerNames: Map<string, string>,
): string {
  return [
    'Infer human names for transcript speaker labels when the name is explicit.',
    'Return only JSON in this shape: [{"speaker":"SPEAKER_0","name":"Alice"}].',
    'If a name is not available, leave it out of the response',
    `Meeting title: ${meeting.title ?? 'Untitled meeting'}`,
    `Speakers: ${speakers.join(', ')}`,
    'Segments:',
    ...segments.map(
      (segment) =>
        `${knownSpeakerNames.get(segment.speaker) ?? segment.speaker}: ${segment.text}`,
    ),
  ].join('\n');
}

function getGeneratedText(result: TextGenerationResult): string {
  if (typeof result === 'string') {
    return result;
  }

  if (Array.isArray(result)) {
    return result[0]?.generated_text ?? '';
  }

  return result.generated_text ?? '';
}

function parseSpeakerNames(text: string): Map<string, string> {
  const parsed = new Map<string, string>();

  try {
    const jsonStart = text.indexOf('[');
    const jsonEnd = text.lastIndexOf(']');

    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      return parsed;
    }

    const json = JSON.parse(text.slice(jsonStart, jsonEnd + 1));

    if (!Array.isArray(json)) {
      return parsed;
    }

    for (const item of json) {
      if (isSpeakerNameGuess(item)) {
        parsed.set(item.speaker, item.name ?? item.speaker);
      }
    }
  } catch {
    // Ignore parse errors
  }

  return parsed;
}

function isSpeakerNameGuess(
  value: unknown,
): value is { speaker: string; name?: string | null } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.speaker === 'string';
}
