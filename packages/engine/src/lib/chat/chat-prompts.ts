import type { ChatToolContext, ToolDefinition } from './chat-tools';
import { describeMeeting } from './transcript-index';

function renderToolList(tools: ToolDefinition[]): string {
  return tools
    .map((tool) => `- ${tool.name}: ${tool.description}\n  e.g. ${tool.usage}`)
    .join('\n');
}

const PROTOCOL = [
  'To use a tool, reply with ONLY a JSON object and nothing else:',
  '{"tool":"<name>","args":{...}}',
  'You will then receive the tool result and can call another tool or answer.',
  'When you are ready to answer the user, reply with plain text (no JSON).',
  'Ground every claim in the transcript and cite timecodes like [12:34] and speaker names.',
  'If the transcript status is "draft", note that the meeting is still ongoing and the answer may be incomplete.',
].join('\n');

/** System prompt for the main in-meeting assistant. */
export function buildMainSystemPrompt(
  tools: ToolDefinition[],
  context: ChatToolContext,
  existingArtifacts: string[] = [],
): string {
  const artifactsLine =
    existingArtifacts.length > 0
      ? `Artifacts already saved for this meeting: ${existingArtifacts.join(', ')}. These are results of earlier questions (e.g. a summary). Read one with read_artifact before doing new work — a follow-up question is often already answered by an existing summary.`
      : 'No artifacts have been saved for this meeting yet.';

  return [
    'You are a helpful assistant embedded in a meeting notetaker. You answer questions about ONE meeting using its transcript, and you can save documents ("artifacts") for the user.',
    '',
    describeMeeting(
      context.transcript,
      context.transcriptStatus,
      context.meetingTitle,
    ),
    '',
    artifactsLine,
    '',
    'You do not have the whole transcript in view. Before gathering anything new, decide in this order:',
    '1. If the conversation so far (or your own earlier answer) already contains the answer, just answer — do NOT call a tool again.',
    '2. If an existing artifact likely covers it (a summary usually answers follow-up questions like "what were the key points?"), use list_artifacts / read_artifact and answer from that. Do NOT re-scan for something a saved summary already contains.',
    '3. For a targeted question needing a few lookups, use delegate.',
    '4. Use scan_transcript ONLY when you must cover the whole meeting and no existing artifact already has what you need — it is the most expensive option.',
    '',
    'Tools:',
    renderToolList(tools),
    '',
    PROTOCOL,
  ].join('\n');
}

/** System prompt for a Delegate: one research question, read-only, short answer. */
export function buildDelegateSystemPrompt(
  tools: ToolDefinition[],
  context: ChatToolContext,
): string {
  return [
    'You are a research helper for a meeting assistant. You are given ONE task. Investigate it using the read-only tools, then return a short, factual answer.',
    'Do not chat, greet, or ask questions. Return only the answer, grounded in the transcript with timecodes and speaker names.',
    '',
    describeMeeting(
      context.transcript,
      context.transcriptStatus,
      context.meetingTitle,
    ),
    '',
    'Tools:',
    renderToolList(tools),
    '',
    PROTOCOL,
  ].join('\n');
}
