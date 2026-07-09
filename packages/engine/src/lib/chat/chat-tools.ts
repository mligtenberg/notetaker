import type { TranscriptStatus } from '@notetaker/filesystem';
import type { Transcript } from '../models/transcript';
import type { ParsedToolCall } from './chat-turn';
import {
  describeMeeting,
  readTranscriptWindow,
  renderHits,
  renderSegments,
  searchTranscript,
} from './transcript-index';

/** Capabilities the tools operate against, injected by the orchestrator. */
export interface ChatToolContext {
  transcript: Transcript | null;
  transcriptStatus: TranscriptStatus;
  meetingTitle: string;
  listArtifacts(): Promise<string[]>;
  readArtifact(name: string): Promise<string | null>;
  /** Write a markdown artifact; resolves to the stored (sanitized) name. */
  writeArtifact(name: string, content: string): Promise<string>;
  /** Spawn a bounded, disposable Delegate; resolves to its distilled answer. */
  runDelegate(task: string): Promise<string>;
  /** Sweep the whole transcript window by window; resolves to the reduced answer. */
  runScan(instruction: string): Promise<string>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** Example invocation shown in the system prompt. */
  usage: string;
}

const MEETING_STATUS: ToolDefinition = {
  name: 'meeting_status',
  description:
    'Get the meeting title, transcript status, length, languages and speakers. Call this first if you are unsure what is available.',
  usage: '{"tool":"meeting_status","args":{}}',
};

const SEARCH_TRANSCRIPT: ToolDefinition = {
  name: 'search_transcript',
  description:
    'Find transcript segments containing keywords. Returns segment indices, timecodes and speakers.',
  usage: '{"tool":"search_transcript","args":{"query":"budget deadline","limit":8}}',
};

const READ_TRANSCRIPT: ToolDefinition = {
  name: 'read_transcript',
  description:
    'Read a window of consecutive segments, by index range (fromIndex/toIndex) or by time in seconds (fromSeconds/toSeconds). Use after search_transcript to read context around a hit.',
  usage: '{"tool":"read_transcript","args":{"fromIndex":40,"toIndex":55}}',
};

const LIST_ARTIFACTS: ToolDefinition = {
  name: 'list_artifacts',
  description: 'List the names of artifacts saved for this meeting.',
  usage: '{"tool":"list_artifacts","args":{}}',
};

const READ_ARTIFACT: ToolDefinition = {
  name: 'read_artifact',
  description: 'Read the markdown content of a saved artifact by name.',
  usage: '{"tool":"read_artifact","args":{"name":"summary"}}',
};

const WRITE_ARTIFACT: ToolDefinition = {
  name: 'write_artifact',
  description:
    'Save a markdown document (a summary, action list, ...) to the meeting. Writing an existing name updates it; the previous version is kept.',
  usage: '{"tool":"write_artifact","args":{"name":"summary","content":"# Summary\\n..."}}',
};

const DELEGATE: ToolDefinition = {
  name: 'delegate',
  description:
    'Hand a self-contained research question to a helper that searches and reads the transcript on its own and returns only a short answer. Best for targeted questions that need a few lookups.',
  usage: '{"tool":"delegate","args":{"task":"What did Bob say about the deadline?"}}',
};

const SCAN_TRANSCRIPT: ToolDefinition = {
  name: 'scan_transcript',
  description:
    'Sweep the ENTIRE transcript window by window, taking a note per window, then return a combined answer. Best for exhaustive tasks over a long meeting (e.g. "summarize the whole meeting", "list every decision/action item"). Prefer this over delegate when you must cover everything.',
  usage: '{"tool":"scan_transcript","args":{"instruction":"List every decision made, with who decided and when."}}',
};

export const READ_ONLY_TOOLS: ToolDefinition[] = [
  MEETING_STATUS,
  SEARCH_TRANSCRIPT,
  READ_TRANSCRIPT,
  LIST_ARTIFACTS,
  READ_ARTIFACT,
];

export const MAIN_TOOLS: ToolDefinition[] = [
  ...READ_ONLY_TOOLS,
  WRITE_ARTIFACT,
  DELEGATE,
  SCAN_TRANSCRIPT,
];

/** Delegates are depth-1 and read-only: no write_artifact, no nested delegate. */
export const DELEGATE_TOOLS: ToolDefinition[] = READ_ONLY_TOOLS;

const READ_WINDOW_CAP = 40;

/** Execute a parsed tool call against the context. Returns a model-facing observation. */
export async function executeTool(
  call: ParsedToolCall,
  context: ChatToolContext,
  allowed: ToolDefinition[],
): Promise<string> {
  if (!allowed.some((tool) => tool.name === call.name)) {
    return `Error: tool "${call.name}" is not available here.`;
  }

  const args = call.args ?? {};

  switch (call.name) {
    case 'meeting_status':
      return describeMeeting(
        context.transcript,
        context.transcriptStatus,
        context.meetingTitle,
      );

    case 'search_transcript': {
      if (context.transcript === null) {
        return 'No transcript is available yet.';
      }
      const query = asString(args.query);
      if (query === null) {
        return 'Error: search_transcript requires a "query" string.';
      }
      const limit = clampNumber(asNumber(args.limit), 1, 20, 8);
      return renderHits(searchTranscript(context.transcript, query, limit));
    }

    case 'read_transcript': {
      if (context.transcript === null) {
        return 'No transcript is available yet.';
      }
      const { startIndex, segments } = readTranscriptWindow(context.transcript, {
        fromIndex: asNumber(args.fromIndex),
        toIndex: asNumber(args.toIndex),
        fromSeconds: asNumber(args.fromSeconds),
        toSeconds: asNumber(args.toSeconds),
        maxSegments: READ_WINDOW_CAP,
      });
      return renderSegments(segments, startIndex);
    }

    case 'list_artifacts': {
      const names = await context.listArtifacts();
      return names.length === 0
        ? 'No artifacts saved yet.'
        : names.map((name) => `- ${name}`).join('\n');
    }

    case 'read_artifact': {
      const name = asString(args.name);
      if (name === null) {
        return 'Error: read_artifact requires a "name" string.';
      }
      const content = await context.readArtifact(name);
      return content ?? `No artifact named "${name}".`;
    }

    case 'write_artifact': {
      const name = asString(args.name);
      const content = asString(args.content);
      if (name === null || content === null) {
        return 'Error: write_artifact requires "name" and "content" strings.';
      }
      const storedName = await context.writeArtifact(name, content);
      return `Saved artifact "${storedName}" (${content.length} characters).`;
    }

    case 'delegate': {
      const task = asString(args.task);
      if (task === null) {
        return 'Error: delegate requires a "task" string.';
      }
      return context.runDelegate(task);
    }

    case 'scan_transcript': {
      if (context.transcript === null) {
        return 'No transcript is available to scan yet.';
      }
      const instruction = asString(args.instruction);
      if (instruction === null) {
        return 'Error: scan_transcript requires an "instruction" string.';
      }
      return context.runScan(instruction);
    }

    default:
      return `Error: unknown tool "${call.name}".`;
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function clampNumber(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}
