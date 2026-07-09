export type ChatRole = 'user' | 'assistant';

/**
 * The processing pipeline's transcript status at the moment a Thread was last
 * used, so the assistant can caveat answers taken from a still-changing draft.
 */
export type TranscriptStatus = 'none' | 'draft' | 'finalized';

/** A single tool call the assistant made while producing an assistant message. */
export interface ToolInvocation {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Serialized result as the model saw it (may be truncated for display). */
  result: string;
  startedAt: number;
  finishedAt: number;
}

/**
 * A pointer from an assistant message to the full working log of a Delegate it
 * spawned. The log itself lives in its own file so its memory is reclaimable.
 */
export interface DelegateRunRef {
  delegateId: string;
  task: string;
  answer: string;
  steps: number;
  /** Name of the Artifact the delegate's output was written to, if any. */
  outputArtifact?: string;
}

/** Pointer from an assistant message to a rolling-window scan it ran. */
export interface ScanRunRef {
  scanId: string;
  instruction: string;
  windowCount: number;
  noteCount: number;
  /** Name of the Artifact the scan's output was written to, if any. */
  outputArtifact?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  /** Assistant-only: tool calls made to produce this message. */
  toolInvocations?: ToolInvocation[];
  /** Assistant-only: delegates spawned to produce this message. */
  delegateRuns?: DelegateRunRef[];
  /** Assistant-only: rolling-window scans run to produce this message. */
  scanRuns?: ScanRunRef[];
  /** Approximate token count of this message, for budget accounting. */
  tokenCount?: number;
}

/** Lightweight thread descriptor for lists; avoids loading full message history. */
export interface ChatThreadMeta {
  id: string;
  meetingId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  transcriptStatus: TranscriptStatus;
}

/** Full thread record, resident only while the thread is open or generating. */
export interface ChatThread extends ChatThreadMeta {
  messages: ChatMessage[];
}

/** One tool call inside a Delegate's transient research context. */
export interface DelegateStep {
  index: number;
  tool: string;
  args: Record<string, unknown>;
  result: string;
  at: number;
}

/** The persisted working log of a single Delegate run. */
export interface DelegateLog {
  id: string;
  threadId: string;
  task: string;
  answer: string;
  steps: DelegateStep[];
  createdAt: number;
  finishedAt: number;
}

/** One window's note from a rolling-window Scan. */
export interface ScanNote {
  windowIndex: number;
  startIndex: number;
  /** Inclusive index of the last segment in the window. */
  endIndex: number;
  startSeconds: number;
  endSeconds: number;
  note: string;
}

/**
 * The persisted record of a Scan: a sweep of the whole transcript in bounded
 * consecutive windows, one note per window, reduced to an answer. Kept in
 * storage so the per-window notes remain inspectable while only the answer
 * enters the conversation.
 */
export interface ScanLog {
  id: string;
  threadId: string;
  instruction: string;
  answer: string;
  notes: ScanNote[];
  windowCount: number;
  createdAt: number;
  finishedAt: number;
}
