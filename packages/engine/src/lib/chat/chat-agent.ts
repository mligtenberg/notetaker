import type { ChatTurn } from './chat-turn';
import type { LanguageModel } from './language-model';
import {
  executeTool,
  type ChatToolContext,
  type ToolDefinition,
} from './chat-tools';
import { parseToolCall, stripToolJson } from './parse-tool-call';

export interface AgentToolInvocation {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: string;
  startedAt: number;
  finishedAt: number;
}

export interface AgentResult {
  answer: string;
  toolInvocations: AgentToolInvocation[];
  steps: number;
}

export interface AgentConfig {
  model: LanguageModel;
  tools: ToolDefinition[];
  context: ChatToolContext;
  /** Max tool-call rounds before the agent must answer. */
  maxSteps: number;
  maxNewTokens: number;
  /** Max prompt tokens; older turns are dropped to fit. */
  contextTokenBudget: number;
  /** Truncate the final answer to this many characters (delegates). */
  answerMaxChars?: number;
  makeId: () => string;
  now: () => number;
  onToken?: (text: string) => void;
  onToolStart?: (invocation: {
    id: string;
    name: string;
    args: Record<string, unknown>;
  }) => void;
  onToolEnd?: (id: string, result: string) => void;
  signal?: AbortSignal;
}

/**
 * Run a ReAct-style loop: generate, and if the model emitted a tool call,
 * execute it and feed the observation back; otherwise treat the output as the
 * final answer. Shared by the main chat and by Delegates (which pass a
 * read-only tool set and tighter caps).
 */
export async function runAgent(
  initialTurns: ChatTurn[],
  config: AgentConfig,
): Promise<AgentResult> {
  const turns = [...initialTurns];
  const toolInvocations: AgentToolInvocation[] = [];

  for (let step = 0; step < config.maxSteps; step += 1) {
    throwIfAborted(config.signal);
    await fitTurns(turns, config.model, config.contextTokenBudget);

    const raw = await generateFiltered(turns, config);
    const toolCall = parseToolCall(raw);

    if (toolCall === null) {
      return {
        answer: finalizeAnswer(raw, config.answerMaxChars),
        toolInvocations,
        steps: step + 1,
      };
    }

    const id = config.makeId();
    const startedAt = config.now();
    config.onToolStart?.({ id, name: toolCall.name, args: toolCall.args });

    const result = await executeTool(toolCall, config.context, config.tools);
    const finishedAt = config.now();
    config.onToolEnd?.(id, result);
    toolInvocations.push({
      id,
      name: toolCall.name,
      args: toolCall.args,
      result,
      startedAt,
      finishedAt,
    });

    turns.push({ role: 'assistant', content: raw });
    turns.push({
      role: 'tool',
      content: `Result of ${toolCall.name}:\n${result}`,
    });
  }

  // Ran out of steps: force a final answer without further tools.
  throwIfAborted(config.signal);
  await fitTurns(turns, config.model, config.contextTokenBudget);
  turns.push({
    role: 'user',
    content:
      'You have gathered enough. Answer now using what you have, without any tool call.',
  });
  const raw = await generateFiltered(turns, config);
  return {
    answer: finalizeAnswer(raw, config.answerMaxChars),
    toolInvocations,
    steps: config.maxSteps,
  };
}

/**
 * Turn a raw generation into a user-facing answer: prefer the prose, and if the
 * model only produced a (now unusable) tool call or nothing, degrade to a clear
 * message rather than dumping JSON scaffolding at the user.
 */
function finalizeAnswer(raw: string, maxChars?: number): string {
  const stripped = stripToolJson(raw);
  if (stripped.length > 0) {
    return capText(stripped, maxChars);
  }

  if (parseToolCall(raw) !== null) {
    return capText(
      'I ran out of research steps before I could answer fully. Please narrow the question or try again.',
      maxChars,
    );
  }

  const trimmed = raw.trim();
  return trimmed.length > 0
    ? capText(trimmed, maxChars)
    : 'I could not produce an answer for that.';
}

/**
 * Generate, streaming prose to onToken but suppressing leading tool-call JSON so
 * the user never sees raw `{"tool":...}` scaffolding. Parsing later uses the
 * full returned text as the source of truth, not this filtered stream.
 */
async function generateFiltered(
  turns: ChatTurn[],
  config: AgentConfig,
): Promise<string> {
  if (!config.onToken) {
    return config.model.generate(turns, {
      maxNewTokens: config.maxNewTokens,
      signal: config.signal,
    });
  }

  let buffer = '';
  let sentLength = 0;
  let mode: 'undecided' | 'prose' | 'tool' = 'undecided';
  const forward = config.onToken;

  return config.model.generate(turns, {
    maxNewTokens: config.maxNewTokens,
    signal: config.signal,
    onToken: (chunk) => {
      buffer += chunk;

      if (mode === 'undecided') {
        const head = buffer.replace(/^\s+/, '');
        if (head.length === 0) {
          return;
        }
        mode = head.startsWith('{') || head.startsWith('```') ? 'tool' : 'prose';
      }

      if (mode === 'prose') {
        forward(buffer.slice(sentLength));
        sentLength = buffer.length;
      }
    },
  });
}

/** Drop oldest non-system turns until the prompt fits the token budget. */
async function fitTurns(
  turns: ChatTurn[],
  model: LanguageModel,
  budget: number,
): Promise<void> {
  const hasSystem = turns.length > 0 && turns[0].role === 'system';
  const floor = hasSystem ? 1 : 0;

  // Keep at least the system turn and the most recent turn.
  while (turns.length - floor > 1) {
    const tokens = await model.countTokens(turns);
    if (tokens <= budget) {
      return;
    }
    turns.splice(floor, 1);
  }
}

function capText(text: string, maxChars?: number): string {
  if (maxChars === undefined || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars).trimEnd()}…`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Chat generation was aborted.', 'AbortError');
  }
}
