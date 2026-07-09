import type { ChatTurn } from './chat-turn';

export interface GenerateOptions {
  maxNewTokens: number;
  /** Called with incremental decoded text as it streams, when supported. */
  onToken?: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * Model abstraction the chat agent runs against. Keeps the agent loop free of
 * transformers.js specifics and trivially testable with a fake model.
 */
export interface LanguageModel {
  /** Maximum prompt+completion tokens the model can hold at once. */
  readonly contextWindow: number;
  /** Approximate token count for a set of turns (for budget/truncation). */
  countTokens(turns: ChatTurn[]): Promise<number>;
  /** Generate the assistant's reply to the given turns. */
  generate(turns: ChatTurn[], options: GenerateOptions): Promise<string>;
}
