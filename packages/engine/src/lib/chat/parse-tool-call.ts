import type { ParsedToolCall } from './chat-turn';

/**
 * Find the first balanced JSON object in text that looks like a tool call
 * (`{"tool": "...", "args": {...}}`). Tolerant of surrounding prose, code
 * fences and trailing tokens from a small model.
 */
export function parseToolCall(text: string): ParsedToolCall | null {
  for (const candidate of balancedObjects(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      continue;
    }

    const record = parsed as Record<string, unknown>;
    if (typeof record.tool === 'string') {
      const args =
        typeof record.args === 'object' && record.args !== null
          ? (record.args as Record<string, unknown>)
          : {};
      return { name: record.tool, args };
    }
  }

  return null;
}

/**
 * The model's prose answer with any tool-call/code-fence JSON removed. Used when
 * no tool call is present, or to salvage prose accompanying a final answer.
 */
export function stripToolJson(text: string): string {
  let result = text;

  for (const candidate of balancedObjects(text)) {
    if (/"tool"\s*:/.test(candidate) || /"answer"\s*:/.test(candidate)) {
      result = result.replace(candidate, '');
    }
  }

  return result
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
}

/** Yield top-level balanced `{...}` substrings, respecting strings and escapes. */
function* balancedObjects(text: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (char === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          yield text.slice(start, i + 1);
          start = -1;
        }
      }
    }
  }
}
