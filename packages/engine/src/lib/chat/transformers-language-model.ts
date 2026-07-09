import { TextStreamer } from '@huggingface/transformers';
import type { ChatTurn } from './chat-turn';
import type { GenerateOptions, LanguageModel } from './language-model';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/** Minimal structural view of a text-generation pipeline + its tokenizer. */
export interface TextGenerationPipelineLike {
  (input: Message[], options?: Record<string, unknown>): Promise<unknown>;
  tokenizer: {
    apply_chat_template: (
      messages: Message[],
      options?: Record<string, unknown>,
    ) => unknown;
  };
  model?: { config?: Record<string, unknown> };
}

const DEFAULT_CONTEXT_WINDOW = 8192;

/** transformers.js text-generation adapter implementing {@link LanguageModel}. */
export class TransformersLanguageModel implements LanguageModel {
  readonly contextWindow: number;

  constructor(private readonly pipeline: TextGenerationPipelineLike) {
    this.contextWindow = readContextWindow(pipeline) ?? DEFAULT_CONTEXT_WINDOW;
  }

  async countTokens(turns: ChatTurn[]): Promise<number> {
    const messages = toMessages(turns);

    try {
      const ids = this.pipeline.tokenizer.apply_chat_template(messages, {
        tokenize: true,
        add_generation_prompt: true,
      });
      const length = tokenizedLength(ids);
      if (length !== null) {
        return length;
      }
    } catch {
      // Fall through to a character-based estimate.
    }

    const chars = messages.reduce((total, m) => total + m.content.length, 0);
    return Math.ceil(chars / 4);
  }

  async generate(turns: ChatTurn[], options: GenerateOptions): Promise<string> {
    const messages = toMessages(turns);
    const generateOptions: Record<string, unknown> = {
      max_new_tokens: options.maxNewTokens,
      do_sample: false,
      return_full_text: false,
    };

    if (options.onToken) {
      const tokenizer = this.pipeline
        .tokenizer as unknown as ConstructorParameters<typeof TextStreamer>[0];
      generateOptions.streamer = new TextStreamer(tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: options.onToken,
      });
    }

    const output = await this.pipeline(messages, generateOptions);
    return extractGeneratedText(output);
  }
}

/**
 * Collapse agent turns into the user/assistant messages the Gemma chat template
 * expects: system instructions and tool results ride as labelled user text, and
 * consecutive same-role turns are merged so the sequence stays alternating.
 */
function toMessages(turns: ChatTurn[]): Message[] {
  const mapped: Message[] = turns.map((turn) => {
    switch (turn.role) {
      case 'assistant':
        return { role: 'assistant', content: turn.content };
      case 'system':
        return { role: 'user', content: `# Instructions\n${turn.content}` };
      case 'tool':
        return { role: 'user', content: `# Tool result\n${turn.content}` };
      case 'user':
      default:
        return { role: 'user', content: turn.content };
    }
  });

  const merged: Message[] = [];
  for (const message of mapped) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) {
      last.content = `${last.content}\n\n${message.content}`;
    } else {
      merged.push({ ...message });
    }
  }

  return merged;
}

function tokenizedLength(ids: unknown): number | null {
  if (Array.isArray(ids)) {
    const first = ids[0];
    if (Array.isArray(first)) {
      return first.length;
    }
    return ids.length;
  }

  const dims = (ids as { dims?: number[] })?.dims;
  if (Array.isArray(dims) && dims.length > 0) {
    return dims[dims.length - 1];
  }

  return null;
}

function extractGeneratedText(output: unknown): string {
  const single = Array.isArray(output) ? output[0] : output;
  const generated = (single as { generated_text?: unknown })?.generated_text;

  if (typeof generated === 'string') {
    return generated;
  }

  if (Array.isArray(generated)) {
    const last = generated[generated.length - 1];
    const content = (last as { content?: unknown })?.content;
    if (typeof content === 'string') {
      return content;
    }
  }

  return '';
}

function readContextWindow(
  pipeline: TextGenerationPipelineLike,
): number | undefined {
  const config = pipeline.model?.config as
    | { max_position_embeddings?: number }
    | undefined;
  const value = config?.max_position_embeddings;
  return typeof value === 'number' && value > 0 ? value : undefined;
}
