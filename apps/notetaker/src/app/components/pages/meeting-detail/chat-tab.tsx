import {
  useMemo,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import type { ChatMessage, MeetingsRepository } from '@notetaker/filesystem';
import type { Transcript } from '@notetaker/engine';
import type { LiveTranscriptSegment } from '../../../app.types';
import { useChatController } from '../../../hooks/use-chat-controller';
import { useMemoryBudget } from '../../../hooks/use-memory-budget';
import { Markdown } from '../../common/markdown';
import { ChatBudgets } from './chat-budgets';
import styles from '../../../app.module.css';

// Placeholder prompt budget shown before the first turn reports the real,
// memory-and-model-derived window. Reply allowance + margin = 1024.
const CHAT_TOKEN_BUDGET_FALLBACK = 8192 - 1024;
const CHAT_REPLY_AND_MARGIN = 1024;

interface ChatTabProps {
  meetingsRepoRef: RefObject<MeetingsRepository | null>;
  meetingId: string;
  meetingTitle: string;
  isRecording: boolean;
  hasTranscript: boolean;
  liveTranscriptSegments: LiveTranscriptSegment[];
}

const STATUS_NOTE: Record<'none' | 'draft' | 'finalized', string> = {
  none: 'No transcript yet — the assistant has little to work with until one is generated.',
  draft: 'Recording in progress — answers use the live draft transcript and may be incomplete.',
  finalized: 'Using the finalized transcript with names and timecodes.',
};

export function ChatTab({
  meetingsRepoRef,
  meetingId,
  meetingTitle,
  isRecording,
  hasTranscript,
  liveTranscriptSegments,
}: ChatTabProps) {
  const [draft, setDraft] = useState('');

  const transcriptStatus = isRecording
    ? 'draft'
    : hasTranscript
      ? 'finalized'
      : 'none';

  const draftTranscript = useMemo<Transcript | null>(() => {
    if (!isRecording || liveTranscriptSegments.length === 0) {
      return null;
    }
    return {
      text: liveTranscriptSegments.map((segment) => segment.text).join(' '),
      segments: liveTranscriptSegments.map((segment) => ({
        text: segment.text,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        speaker: 'SPEAKER_0',
        speakerName: 'Speaker',
      })),
    };
  }, [isRecording, liveTranscriptSegments]);

  const chat = useChatController({
    meetingsRepoRef,
    meetingId,
    meetingTitle,
    transcriptStatus,
    recordingActive: isRecording,
    draftTranscript,
  });

  function submit(): void {
    const text = draft;
    setDraft('');
    void chat.sendMessage(text);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!chat.isGenerating && draft.trim().length > 0) {
        submit();
      }
    }
  }

  const memory = useMemoryBudget(isRecording, 0, chat.contextTokens);
  const messages = chat.activeThread?.messages ?? [];
  const showEmpty = messages.length === 0 && chat.pending === null;

  const threadTokens = useMemo(() => {
    let total = messages.reduce(
      (sum, message) =>
        sum + (message.tokenCount ?? Math.ceil(message.content.length / 4)),
      0,
    );
    if (chat.pending !== null) {
      total +=
        Math.ceil(chat.pending.userText.length / 4) +
        Math.ceil(chat.pending.streamingText.length / 4);
    }
    return total;
  }, [messages, chat.pending]);

  return (
    <div className={styles.chatLayout}>
      <aside className={styles.chatThreadList}>
        <button
          type="button"
          className={styles.chatNewThread}
          onClick={chat.newThread}
        >
          + New chat
        </button>
        {chat.threads.length === 0 ? (
          <p className={styles.empty}>No chats yet.</p>
        ) : (
          <ul>
            {chat.threads.map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  data-active={thread.id === chat.activeThreadId}
                  className={styles.chatThreadItem}
                  onClick={() => void chat.selectThread(thread.id)}
                >
                  <span>{thread.title || 'Untitled chat'}</span>
                  <small>{thread.messageCount} messages</small>
                </button>
                <button
                  type="button"
                  aria-label="Delete chat"
                  className={styles.chatThreadDelete}
                  onClick={() => void chat.deleteThread(thread.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className={styles.chatMain}>
        <ChatBudgets
          memory={memory}
          threadTokens={threadTokens}
          tokenBudget={
            chat.contextTokens !== null
              ? chat.contextTokens - CHAT_REPLY_AND_MARGIN
              : CHAT_TOKEN_BUDGET_FALLBACK
          }
        />
        <p className={styles.chatStatusBanner} data-status={transcriptStatus}>
          {STATUS_NOTE[transcriptStatus]}
        </p>

        <div className={styles.chatMessages}>
          {showEmpty ? (
            <p className={styles.empty}>
              Ask about this meeting — decisions, action items, who said what.
            </p>
          ) : null}

          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}

          {chat.pending !== null ? (
            <>
              <div className={styles.chatMessage} data-role="user">
                <span>{chat.pending.userText}</span>
              </div>
              <div className={styles.chatMessage} data-role="assistant">
                {chat.pending.activities.length > 0 ? (
                  <ul className={styles.chatActivity}>
                    {chat.pending.activities.map((activity) => (
                      <li key={activity.id} data-status={activity.status}>
                        {activity.label}
                        {activity.detail ? `: ${activity.detail}` : ''}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <span>
                  {chat.pending.streamingText.length > 0
                    ? chat.pending.streamingText
                    : '…'}
                </span>
              </div>
            </>
          ) : null}

          {chat.error !== null ? (
            <p className={styles.chatError}>{chat.error}</p>
          ) : null}
        </div>

        <div className={styles.chatComposer}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about this meeting…"
            rows={2}
            disabled={chat.isGenerating}
          />
          <button
            type="button"
            onClick={submit}
            disabled={chat.isGenerating || draft.trim().length === 0}
          >
            {chat.isGenerating ? 'Thinking…' : 'Send'}
          </button>
        </div>
      </section>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const toolCount = message.toolInvocations?.length ?? 0;
  const delegateCount = message.delegateRuns?.length ?? 0;
  const scanCount = message.scanRuns?.length ?? 0;
  const footnotes: string[] = [];
  if (toolCount > 0) {
    footnotes.push(`${toolCount} lookup${toolCount === 1 ? '' : 's'}`);
  }
  if (delegateCount > 0) {
    footnotes.push(`${delegateCount} research task${delegateCount === 1 ? '' : 's'}`);
  }
  if (scanCount > 0) {
    const windows = message.scanRuns?.reduce((sum, run) => sum + run.windowCount, 0) ?? 0;
    footnotes.push(`scanned ${windows} window${windows === 1 ? '' : 's'}`);
  }
  const outputArtifacts = [
    ...(message.delegateRuns ?? []).map((run) => run.outputArtifact),
    ...(message.scanRuns ?? []).map((run) => run.outputArtifact),
  ].filter((name): name is string => typeof name === 'string');
  if (outputArtifacts.length > 0) {
    footnotes.push(`saved to ${outputArtifacts.join(', ')}`);
  }

  return (
    <div className={styles.chatMessage} data-role={message.role}>
      {message.role === 'assistant' ? (
        <Markdown content={message.content} />
      ) : (
        <span>{message.content}</span>
      )}
      {footnotes.length > 0 ? (
        <small className={styles.chatFootnote}>{footnotes.join(' · ')}</small>
      ) : null}
    </div>
  );
}
