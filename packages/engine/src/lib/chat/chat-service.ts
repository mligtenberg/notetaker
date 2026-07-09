import type {
  ChatMessage,
  ChatThread,
  DelegateLog,
  DelegateRunRef,
  DelegateStep,
  ScanLog,
  ScanRunRef,
  ToolInvocation,
  TranscriptStatus,
} from '@notetaker/filesystem';
import type { Transcript } from '../models/transcript';
import type { ChatTurn } from './chat-turn';
import type { LanguageModel } from './language-model';
import type { ChatEvent } from './chat-events';
import {
  DELEGATE_TOOLS,
  MAIN_TOOLS,
  type ChatToolContext,
} from './chat-tools';
import {
  runAgent,
  type AgentToolInvocation,
} from './chat-agent';
import {
  buildDelegateSystemPrompt,
  buildMainSystemPrompt,
} from './chat-prompts';
import { runRollingScan } from './rolling-scan';
import { formatTimecode } from './transcript-index';

export interface ChatArtifactAccess {
  list(): Promise<string[]>;
  read(name: string): Promise<string | null>;
  /** Write an artifact; resolves to the stored (sanitized) name. */
  write(name: string, content: string): Promise<string>;
}

/** Preview length of a subagent answer inlined alongside its artifact pointer. */
const OUTPUT_PREVIEW_CHARS = 600;

export interface RunChatTurnInput {
  /** The thread's prior messages (NOT including the new user message). */
  thread: ChatThread;
  userText: string;
  transcript: Transcript | null;
  transcriptStatus: TranscriptStatus;
  meetingTitle: string;
  artifacts: ChatArtifactAccess;
  onEvent: (event: ChatEvent) => void;
  persistDelegateLog: (log: DelegateLog) => Promise<void>;
  persistScanLog: (log: ScanLog) => Promise<void>;
  signal?: AbortSignal;
}

export interface ChatServiceOptions {
  makeId?: () => string;
  now?: () => number;
  mainMaxSteps?: number;
  mainMaxNewTokens?: number;
  delegateMaxSteps?: number;
  delegateMaxNewTokens?: number;
  delegateAnswerMaxChars?: number;
  scanWindowSize?: number;
  scanMaxWindows?: number;
  scanAnswerMaxChars?: number;
  /** Tokens reserved below the context window for the completion + overhead. */
  contextTokenMargin?: number;
  /** Cap the prompt window (below the model's own), e.g. what memory affords. */
  maxContextTokens?: number;
}

const DEFAULTS = {
  mainMaxSteps: 6,
  mainMaxNewTokens: 512,
  delegateMaxSteps: 5,
  delegateMaxNewTokens: 384,
  delegateAnswerMaxChars: 1200,
  scanWindowSize: 30,
  scanMaxWindows: 40,
  scanAnswerMaxChars: 2000,
  contextTokenMargin: 512,
};

/** The read-only slice of the tool context shared by main chat and sub-agents. */
type ReadContext = Omit<
  ChatToolContext,
  'writeArtifact' | 'runDelegate' | 'runScan'
>;

/**
 * Orchestrates one chat turn: seeds the main agent from prior thread messages,
 * runs it with the full tool set, and implements the delegate tool by spawning
 * bounded read-only sub-agents whose working logs are persisted (so their
 * memory can be reclaimed) while only their answers return to the conversation.
 */
export class ChatService {
  readonly #model: LanguageModel;
  readonly #makeId: () => string;
  readonly #now: () => number;
  readonly #maxContextTokens: number | undefined;
  readonly #options: Required<Omit<ChatServiceOptions, 'maxContextTokens'>>;

  constructor(model: LanguageModel, options: ChatServiceOptions = {}) {
    this.#model = model;
    this.#makeId = options.makeId ?? defaultMakeId;
    this.#now = options.now ?? (() => Date.now());
    this.#maxContextTokens = options.maxContextTokens;
    this.#options = {
      makeId: this.#makeId,
      now: this.#now,
      mainMaxSteps: options.mainMaxSteps ?? DEFAULTS.mainMaxSteps,
      mainMaxNewTokens: options.mainMaxNewTokens ?? DEFAULTS.mainMaxNewTokens,
      delegateMaxSteps: options.delegateMaxSteps ?? DEFAULTS.delegateMaxSteps,
      delegateMaxNewTokens:
        options.delegateMaxNewTokens ?? DEFAULTS.delegateMaxNewTokens,
      delegateAnswerMaxChars:
        options.delegateAnswerMaxChars ?? DEFAULTS.delegateAnswerMaxChars,
      scanWindowSize: options.scanWindowSize ?? DEFAULTS.scanWindowSize,
      scanMaxWindows: options.scanMaxWindows ?? DEFAULTS.scanMaxWindows,
      scanAnswerMaxChars:
        options.scanAnswerMaxChars ?? DEFAULTS.scanAnswerMaxChars,
      contextTokenMargin:
        options.contextTokenMargin ?? DEFAULTS.contextTokenMargin,
    };
  }

  async runTurn(input: RunChatTurnInput): Promise<ChatMessage> {
    const delegateRuns: DelegateRunRef[] = [];
    const scanRuns: ScanRunRef[] = [];

    const readContext = {
      transcript: input.transcript,
      transcriptStatus: input.transcriptStatus,
      meetingTitle: input.meetingTitle,
      listArtifacts: () => input.artifacts.list(),
      readArtifact: (name: string) => input.artifacts.read(name),
    };

    const mainContext: ChatToolContext = {
      ...readContext,
      writeArtifact: (name, content) => input.artifacts.write(name, content),
      runDelegate: (task) => this.#runDelegate(task, input, readContext, delegateRuns),
      runScan: (instruction) => this.#runScan(instruction, input, scanRuns),
    };

    // Surface existing artifacts so the model reuses a prior summary instead of
    // re-scanning for something it already has.
    const existingArtifacts = await input.artifacts.list().catch(() => []);
    const systemPrompt = buildMainSystemPrompt(
      MAIN_TOOLS,
      mainContext,
      existingArtifacts,
    );
    const turns: ChatTurn[] = [
      { role: 'system', content: systemPrompt },
      ...input.thread.messages.map(toTurn),
      { role: 'user', content: input.userText },
    ];

    const result = await runAgent(turns, {
      model: this.#model,
      tools: MAIN_TOOLS,
      context: mainContext,
      maxSteps: this.#options.mainMaxSteps,
      maxNewTokens: this.#options.mainMaxNewTokens,
      contextTokenBudget: this.#promptBudget(this.#options.mainMaxNewTokens),
      makeId: this.#makeId,
      now: this.#now,
      onToken: (text) => input.onEvent({ type: 'token', text }),
      onToolStart: ({ id, name, args }) => {
        if (name === 'delegate' || name === 'scan_transcript') {
          return; // delegate-* / scan-* events represent these instead.
        }
        input.onEvent({ type: 'tool-start', id, name, args });
      },
      onToolEnd: (id, resultText) => {
        input.onEvent({ type: 'tool-end', id, result: resultText });
      },
      signal: input.signal,
    });

    const toolInvocations = result.toolInvocations
      .filter(
        (invocation) =>
          invocation.name !== 'delegate' &&
          invocation.name !== 'scan_transcript',
      )
      .map(toStoredInvocation);

    return {
      id: this.#makeId(),
      role: 'assistant',
      content: result.answer,
      createdAt: this.#now(),
      toolInvocations: toolInvocations.length > 0 ? toolInvocations : undefined,
      delegateRuns: delegateRuns.length > 0 ? delegateRuns : undefined,
      scanRuns: scanRuns.length > 0 ? scanRuns : undefined,
      tokenCount: Math.ceil(result.answer.length / 4),
    };
  }

  /** Prompt-token budget: the effective window (model, capped by memory) less
   * the reply allowance and margin. */
  #promptBudget(replyTokens: number): number {
    const window = Math.min(
      this.#model.contextWindow,
      this.#maxContextTokens ?? Number.POSITIVE_INFINITY,
    );
    return Math.max(
      1024,
      window - replyTokens - this.#options.contextTokenMargin,
    );
  }

  async #runDelegate(
    task: string,
    input: RunChatTurnInput,
    readContext: ReadContext,
    delegateRuns: DelegateRunRef[],
  ): Promise<string> {
    const delegateId = this.#makeId();
    const createdAt = this.#now();
    input.onEvent({ type: 'delegate-start', delegateId, task });

    const delegateContext: ChatToolContext = {
      ...readContext,
      writeArtifact: () => {
        throw new Error('Delegates cannot write artifacts.');
      },
      runDelegate: () =>
        Promise.resolve('Error: delegates cannot spawn further delegates.'),
      runScan: () =>
        Promise.resolve('Error: delegates cannot start a transcript scan.'),
    };

    const systemPrompt = buildDelegateSystemPrompt(
      DELEGATE_TOOLS,
      delegateContext,
    );

    let stepCounter = 0;
    const result = await runAgent(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: task },
      ],
      {
        model: this.#model,
        tools: DELEGATE_TOOLS,
        context: delegateContext,
        maxSteps: this.#options.delegateMaxSteps,
        maxNewTokens: this.#options.delegateMaxNewTokens,
        contextTokenBudget: this.#promptBudget(this.#options.delegateMaxNewTokens),
        answerMaxChars: this.#options.delegateAnswerMaxChars,
        makeId: this.#makeId,
        now: this.#now,
        onToolStart: ({ name }) => {
          input.onEvent({
            type: 'delegate-step',
            delegateId,
            index: stepCounter,
            tool: name,
          });
          stepCounter += 1;
        },
        signal: input.signal,
      },
    );

    const steps: DelegateStep[] = result.toolInvocations.map(
      (invocation, index) => ({
        index,
        tool: invocation.name,
        args: invocation.args,
        result: invocation.result,
        at: invocation.finishedAt,
      }),
    );

    const log: DelegateLog = {
      id: delegateId,
      threadId: input.thread.id,
      task,
      answer: result.answer,
      steps,
      createdAt,
      finishedAt: this.#now(),
    };
    await input.persistDelegateLog(log);

    const markdown = `# Research\n\n**Task:** ${task}\n\n${result.answer}\n`;
    const artifact = await this.#deliverArtifact(
      'research',
      task,
      markdown,
      input,
      delegateId,
    );

    input.onEvent({
      type: 'delegate-end',
      delegateId,
      answer: result.answer,
      steps: steps.length,
      artifact,
    });
    delegateRuns.push({
      delegateId,
      task,
      answer: result.answer,
      steps: steps.length,
      outputArtifact: artifact,
    });

    return this.#outputPointer(artifact, result.answer);
  }

  async #runScan(
    instruction: string,
    input: RunChatTurnInput,
    scanRuns: ScanRunRef[],
  ): Promise<string> {
    if (input.transcript === null) {
      return 'No transcript is available to scan yet.';
    }

    const scanId = this.#makeId();
    const createdAt = this.#now();

    const result = await runRollingScan(
      this.#model,
      input.transcript,
      instruction,
      {
        windowSize: this.#options.scanWindowSize,
        maxWindows: this.#options.scanMaxWindows,
        answerMaxChars: this.#options.scanAnswerMaxChars,
      },
      {
        onStart: (totalWindows) =>
          input.onEvent({
            type: 'scan-start',
            scanId,
            instruction,
            totalWindows,
          }),
        onWindow: (index, total) =>
          input.onEvent({ type: 'scan-progress', scanId, index, total }),
        signal: input.signal,
      },
    );

    const log: ScanLog = {
      id: scanId,
      threadId: input.thread.id,
      instruction,
      answer: result.answer,
      notes: result.notes,
      windowCount: result.windowCount,
      createdAt,
      finishedAt: this.#now(),
    };
    await input.persistScanLog(log);

    const notesSection =
      result.notes.length > 0
        ? `\n\n## Notes by section\n${result.notes
            .map(
              (note) =>
                `- [${formatTimecode(note.startSeconds)}–${formatTimecode(note.endSeconds)}] ${note.note}`,
            )
            .join('\n')}`
        : '';
    const markdown = `# Scan\n\n**Task:** ${instruction}\n\n${result.answer}${notesSection}\n`;
    const artifact = await this.#deliverArtifact(
      'scan',
      instruction,
      markdown,
      input,
      scanId,
    );

    input.onEvent({
      type: 'scan-end',
      scanId,
      noteCount: result.notes.length,
      windowCount: result.windowCount,
      artifact,
    });
    scanRuns.push({
      scanId,
      instruction,
      windowCount: result.windowCount,
      noteCount: result.notes.length,
      outputArtifact: artifact,
    });

    return this.#outputPointer(artifact, result.answer);
  }

  /** Persist a subagent's output as an Artifact; returns the stored name. */
  async #deliverArtifact(
    prefix: 'research' | 'scan',
    title: string,
    markdown: string,
    input: RunChatTurnInput,
    id: string,
  ): Promise<string> {
    const name = `${prefix}-${slug(title)}-${id.slice(0, 6)}`;
    return input.artifacts.write(name, markdown);
  }

  /**
   * The observation the main chat receives: a pointer to the output artifact
   * plus a short preview. The full result stays in the artifact so it never
   * bloats the main conversation — the chat reads it only if it needs more.
   */
  #outputPointer(artifact: string, answer: string): string {
    const preview =
      answer.length > OUTPUT_PREVIEW_CHARS
        ? `${answer.slice(0, OUTPUT_PREVIEW_CHARS).trimEnd()}…`
        : answer;
    return `Saved the full result as artifact "${artifact}". Read it with read_artifact "${artifact}" for everything; preview:\n\n${preview}`;
  }
}

/** A short, filename-safe slug for naming output artifacts. */
function slug(text: string): string {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'output';
}

function toTurn(message: Pick<ChatMessage, 'role' | 'content'>): ChatTurn {
  return { role: message.role, content: message.content };
}

function toStoredInvocation(invocation: AgentToolInvocation): ToolInvocation {
  return {
    id: invocation.id,
    name: invocation.name,
    args: invocation.args,
    result: invocation.result,
    startedAt: invocation.startedAt,
    finishedAt: invocation.finishedAt,
  };
}

function defaultMakeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
