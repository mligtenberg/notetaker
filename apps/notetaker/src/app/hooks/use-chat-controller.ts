import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type {
  ChatMessage,
  ChatThread,
  ChatThreadMeta,
  MeetingsRepository,
} from '@notetaker/filesystem';
import type { ChatEvent, Transcript } from '@notetaker/engine';
import { getSharedEngineWorker } from '../engine-worker-instance';
import type {
  ChatWorkerRequest,
  ChatWorkerResponse,
} from '../chat/chat-worker-protocol';
import { isChatWorkerResponse } from '../chat/chat-worker-protocol';

/** Distinct id range so chat messages never collide with engine request ids. */
const CHAT_ID_BASE = 1_000_000_000;

export interface ChatActivity {
  kind: 'tool' | 'delegate';
  id: string;
  label: string;
  status: 'running' | 'done';
  detail?: string;
}

export interface ChatPending {
  userText: string;
  streamingText: string;
  activities: ChatActivity[];
}

export interface UseChatControllerOptions {
  meetingsRepoRef: RefObject<MeetingsRepository | null>;
  meetingId: string | null;
  meetingTitle: string;
  transcriptStatus: 'none' | 'draft' | 'finalized';
  recordingActive: boolean;
  /** Optional draft transcript to chat against while recording. */
  draftTranscript?: Transcript | null;
  budgetBytes?: number;
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function deriveTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= 48 ? trimmed : `${trimmed.slice(0, 47)}…`;
}

export function useChatController({
  meetingsRepoRef,
  meetingId,
  meetingTitle,
  transcriptStatus,
  recordingActive,
  draftTranscript,
  budgetBytes,
}: UseChatControllerOptions) {
  const [threads, setThreads] = useState<ChatThreadMeta[]>([]);
  const [activeThread, setActiveThread] = useState<ChatThread | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [pending, setPending] = useState<ChatPending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contextTokens, setContextTokens] = useState<number | null>(null);
  const requestIdRef = useRef(CHAT_ID_BASE);

  const refresh = useCallback(async (): Promise<void> => {
    const repo = meetingsRepoRef.current;
    if (repo === null || meetingId === null) {
      setThreads([]);
      return;
    }
    setThreads(await repo.listThreads(meetingId));
  }, [meetingsRepoRef, meetingId]);

  // Aggressive eviction: switching meetings drops the resident thread; only its
  // OPFS copy remains.
  useEffect(() => {
    setActiveThread(null);
    setPending(null);
    setError(null);
    void refresh();
  }, [refresh]);

  const selectThread = useCallback(
    async (threadId: string): Promise<void> => {
      const repo = meetingsRepoRef.current;
      if (repo === null || meetingId === null) {
        return;
      }
      setError(null);
      const thread = await repo.loadThread(meetingId, threadId);
      setActiveThread(thread);
    },
    [meetingsRepoRef, meetingId],
  );

  const newThread = useCallback((): void => {
    // Drop the resident thread; a fresh one is created on first send.
    setActiveThread(null);
    setPending(null);
    setError(null);
  }, []);

  const deleteThread = useCallback(
    async (threadId: string): Promise<void> => {
      const repo = meetingsRepoRef.current;
      if (repo === null || meetingId === null) {
        return;
      }
      await repo.deleteThread(meetingId, threadId);
      setActiveThread((current) => (current?.id === threadId ? null : current));
      await refresh();
    },
    [meetingsRepoRef, meetingId, refresh],
  );

  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      const repo = meetingsRepoRef.current;
      const trimmed = text.trim();
      if (repo === null || meetingId === null || trimmed.length === 0 || isGenerating) {
        return;
      }

      const now = Date.now();
      const existing = activeThread;
      const thread: ChatThread =
        existing ?? {
          id: makeId(),
          meetingId,
          title: deriveTitle(trimmed),
          createdAt: now,
          updatedAt: now,
          messageCount: 0,
          transcriptStatus,
          messages: [],
        };
      const priorMessages = thread.messages;

      const userMessage: ChatMessage = {
        id: makeId(),
        role: 'user',
        content: trimmed,
        createdAt: now,
      };

      setError(null);
      setIsGenerating(true);
      setPending({ userText: trimmed, streamingText: '', activities: [] });

      const requestId = ++requestIdRef.current;
      const worker = getSharedEngineWorker();

      const assistantMessage = await new Promise<ChatMessage | null>((resolve) => {
        const handleMessage = (event: MessageEvent<ChatWorkerResponse>) => {
          const message = event.data;
          if (!isChatWorkerResponse(message) || message.id !== requestId) {
            return;
          }

          if (message.type === 'chat-event') {
            applyEvent(message.event, setPending);
            return;
          }

          worker.removeEventListener('message', handleMessage);
          if (message.ok) {
            setContextTokens(message.contextTokens);
            resolve(message.message);
          } else {
            setError(message.error);
            resolve(null);
          }
        };

        worker.addEventListener('message', handleMessage);

        const request: ChatWorkerRequest = {
          id: requestId,
          mode: 'chat',
          chat: {
            threadId: thread.id,
            meetingId,
            meetingTitle,
            userText: trimmed,
            priorMessages,
            transcriptStatus,
            transcript: draftTranscript ?? undefined,
            recordingActive,
            budgetBytes,
          },
        };
        worker.postMessage(request);
      });

      if (assistantMessage !== null) {
        const updated: ChatThread = {
          ...thread,
          title: thread.title || deriveTitle(trimmed),
          updatedAt: Date.now(),
          messages: [...priorMessages, userMessage, assistantMessage],
          messageCount: priorMessages.length + 2,
        };
        await repo.saveThread(meetingId, updated);
        setActiveThread(updated);
        await refresh();
      }

      setPending(null);
      setIsGenerating(false);
    },
    [
      meetingsRepoRef,
      meetingId,
      meetingTitle,
      transcriptStatus,
      recordingActive,
      draftTranscript,
      budgetBytes,
      activeThread,
      isGenerating,
      refresh,
    ],
  );

  return {
    threads,
    activeThread,
    activeThreadId: activeThread?.id ?? null,
    isGenerating,
    pending,
    error,
    contextTokens,
    refresh,
    selectThread,
    newThread,
    deleteThread,
    sendMessage,
  };
}

function applyEvent(
  event: ChatEvent,
  setPending: React.Dispatch<React.SetStateAction<ChatPending | null>>,
): void {
  setPending((current) => {
    if (current === null) {
      return current;
    }

    switch (event.type) {
      case 'token':
        return { ...current, streamingText: current.streamingText + event.text };
      case 'tool-start':
        return {
          ...current,
          activities: [
            ...current.activities,
            {
              kind: 'tool',
              id: event.id,
              label: `Looking up: ${event.name}`,
              status: 'running',
            },
          ],
        };
      case 'tool-end':
        return {
          ...current,
          activities: current.activities.map((activity) =>
            activity.id === event.id
              ? { ...activity, status: 'done' }
              : activity,
          ),
        };
      case 'delegate-start':
        return {
          ...current,
          activities: [
            ...current.activities,
            {
              kind: 'delegate',
              id: event.delegateId,
              label: 'Researching',
              status: 'running',
              detail: event.task,
            },
          ],
        };
      case 'delegate-step':
        return {
          ...current,
          activities: current.activities.map((activity) =>
            activity.id === event.delegateId
              ? { ...activity, label: `Researching (step ${event.index + 1})` }
              : activity,
          ),
        };
      case 'delegate-end':
        return {
          ...current,
          activities: current.activities.map((activity) =>
            activity.id === event.delegateId
              ? {
                  ...activity,
                  status: 'done',
                  label: `Researched (${event.steps} step${event.steps === 1 ? '' : 's'})`,
                }
              : activity,
          ),
        };
      case 'scan-start':
        return {
          ...current,
          activities: [
            ...current.activities,
            {
              kind: 'delegate',
              id: event.scanId,
              label: `Scanning transcript (0/${event.totalWindows})`,
              status: 'running',
              detail: event.instruction,
            },
          ],
        };
      case 'scan-progress':
        return {
          ...current,
          activities: current.activities.map((activity) =>
            activity.id === event.scanId
              ? {
                  ...activity,
                  label: `Scanning transcript (${event.index + 1}/${event.total})`,
                }
              : activity,
          ),
        };
      case 'scan-end':
        return {
          ...current,
          activities: current.activities.map((activity) =>
            activity.id === event.scanId
              ? {
                  ...activity,
                  status: 'done',
                  label: `Scanned ${event.windowCount} window${event.windowCount === 1 ? '' : 's'} (${event.noteCount} note${event.noteCount === 1 ? '' : 's'})`,
                }
              : activity,
          ),
        };
      default:
        return current;
    }
  });
}
