/** A single turn in the model-facing conversation (distinct from a stored ChatMessage). */
export type ChatTurnRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatTurn {
  role: ChatTurnRole;
  content: string;
}

/** A tool call the model asked for, parsed from its output. */
export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}
