import type { ChatEvent } from '@notetaker/engine';
import type {
  ChatMessage,
  TranscriptStatus,
} from '@notetaker/filesystem';
import type { Transcript } from '@notetaker/engine';

/** Request the app posts to run one chat turn inside the engine worker. */
export interface ChatWorkerRequest {
  id: number;
  mode: 'chat';
  chat: {
    threadId: string;
    meetingId: string;
    meetingTitle: string;
    userText: string;
    /** Prior thread messages, oldest first (excludes the new user message). */
    priorMessages: ChatMessage[];
    transcriptStatus: TranscriptStatus;
    /** Optional draft/live transcript to use instead of the saved one. */
    transcript?: Transcript;
    /** Whether a recording/pipeline run is active — it keeps memory priority. */
    recordingActive: boolean;
    /** Optional user override of the app-wide memory budget, in bytes. */
    budgetBytes?: number;
  };
}

export type ChatWorkerResponse =
  | { id: number; type: 'chat-event'; event: ChatEvent }
  | {
      id: number;
      type: 'chat-result';
      ok: true;
      message: ChatMessage;
      /** Effective prompt-token window used this turn (memory + model derived). */
      contextTokens: number;
    }
  | { id: number; type: 'chat-result'; ok: false; error: string };

export function isChatWorkerResponse(
  value: { type?: string },
): value is ChatWorkerResponse {
  return value.type === 'chat-event' || value.type === 'chat-result';
}
