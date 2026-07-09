import { describe, expect, it } from 'vitest';
import { parseToolCall, stripToolJson } from './parse-tool-call';
import {
  readTranscriptWindow,
  searchTranscript,
} from './transcript-index';
import { runAgent } from './chat-agent';
import { runRollingScan } from './rolling-scan';
import { ChatService, type RunChatTurnInput } from './chat-service';
import { buildMainSystemPrompt } from './chat-prompts';
import type { ChatTurn } from './chat-turn';
import type { GenerateOptions, LanguageModel } from './language-model';
import { MAIN_TOOLS, type ChatToolContext } from './chat-tools';
import {
  MemoryBudget,
  estimateKvCacheBytes,
  resolveContextTokens,
} from '../memory-budget';
import type { Transcript } from '../models/transcript';

const transcript: Transcript = {
  text: '',
  language: 'en',
  segments: [
    { text: 'We need to set the Q4 budget.', startSeconds: 0, endSeconds: 4, speaker: 'SPEAKER_0', speakerName: 'Alice' },
    { text: 'The deadline is next Friday.', startSeconds: 4, endSeconds: 7, speaker: 'SPEAKER_1', speakerName: 'Bob' },
    { text: 'Alice will own the budget draft.', startSeconds: 7, endSeconds: 11, speaker: 'SPEAKER_1', speakerName: 'Bob' },
    { text: 'Great, let us move on.', startSeconds: 11, endSeconds: 13, speaker: 'SPEAKER_0', speakerName: 'Alice' },
  ],
};

/** A scripted model: returns the next queued output regardless of input. */
class ScriptedModel implements LanguageModel {
  readonly contextWindow = 8192;
  #queue: string[];
  readonly seen: ChatTurn[][] = [];

  constructor(outputs: string[]) {
    this.#queue = [...outputs];
  }

  async countTokens(turns: ChatTurn[]): Promise<number> {
    return turns.reduce((total, t) => total + Math.ceil(t.content.length / 4), 0);
  }

  async generate(turns: ChatTurn[], options: GenerateOptions): Promise<string> {
    this.seen.push(turns);
    const out = this.#queue.shift() ?? 'No more scripted output.';
    options.onToken?.(out);
    return out;
  }
}

function baseContext(overrides: Partial<ChatToolContext> = {}): ChatToolContext {
  return {
    transcript,
    transcriptStatus: 'finalized',
    meetingTitle: 'Planning',
    listArtifacts: async () => [],
    readArtifact: async () => null,
    writeArtifact: async (name: string) => name,
    runDelegate: async () => 'delegated answer',
    runScan: async () => 'scanned answer',
    ...overrides,
  };
}

const agentDefaults = {
  maxSteps: 6,
  maxNewTokens: 256,
  contextTokenBudget: 4000,
  makeId: (() => {
    let n = 0;
    return () => `id-${n++}`;
  })(),
  now: (() => {
    let t = 1000;
    return () => (t += 1);
  })(),
};

describe('parseToolCall', () => {
  it('extracts a tool call embedded in prose and code fences', () => {
    const text = 'Let me look.\n```json\n{"tool":"search_transcript","args":{"query":"budget"}}\n```';
    expect(parseToolCall(text)).toEqual({
      name: 'search_transcript',
      args: { query: 'budget' },
    });
  });

  it('returns null for a plain prose answer', () => {
    expect(parseToolCall('The budget is decided at [0:00].')).toBeNull();
  });

  it('handles braces inside string values', () => {
    const text = '{"tool":"write_artifact","args":{"name":"s","content":"a {b} c"}}';
    expect(parseToolCall(text)?.args.content).toBe('a {b} c');
  });

  it('strips tool/answer JSON from prose', () => {
    expect(stripToolJson('```json\n{"answer":"x"}\n```\nHello')).toBe('Hello');
  });
});

describe('transcript-index', () => {
  it('ranks segments mentioning the query terms', () => {
    const hits = searchTranscript(transcript, 'budget');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toContain('budget');
  });

  it('reads a window by index with the correct start index', () => {
    const { startIndex, segments } = readTranscriptWindow(transcript, {
      fromIndex: 1,
      toIndex: 2,
    });
    expect(startIndex).toBe(1);
    expect(segments).toHaveLength(2);
    expect(segments[0].speakerName).toBe('Bob');
  });

  it('reads a window by time range', () => {
    const { segments } = readTranscriptWindow(transcript, {
      fromSeconds: 4,
      toSeconds: 8,
    });
    expect(segments.map((s) => s.text)).toContain('The deadline is next Friday.');
  });
});

describe('runAgent', () => {
  it('runs a tool then answers, feeding the observation back', async () => {
    const model = new ScriptedModel([
      '{"tool":"search_transcript","args":{"query":"deadline"}}',
      'The deadline is next Friday [0:04], per Bob.',
    ]);
    const result = await runAgent(
      [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'When is the deadline?' },
      ],
      { ...agentDefaults, model, tools: MAIN_LIKE_TOOLS, context: baseContext() },
    );

    expect(result.toolInvocations).toHaveLength(1);
    expect(result.toolInvocations[0].name).toBe('search_transcript');
    expect(result.answer).toContain('Friday');
    // The second generation must have seen the tool observation turn.
    const lastPrompt = model.seen[model.seen.length - 1];
    expect(lastPrompt.some((t) => t.role === 'tool')).toBe(true);
  });

  it('forces an answer when the step cap is reached', async () => {
    // 3 tool calls exhaust the step cap; the 4th (forced) generation answers.
    const model = new ScriptedModel([
      '{"tool":"meeting_status","args":{}}',
      '{"tool":"meeting_status","args":{}}',
      '{"tool":"meeting_status","args":{}}',
      'Final forced answer.',
    ]);
    const result = await runAgent(
      [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hi' },
      ],
      { ...agentDefaults, maxSteps: 3, model, tools: MAIN_LIKE_TOOLS, context: baseContext() },
    );
    expect(result.steps).toBe(3);
    expect(result.answer).toBe('Final forced answer.');
  });

  it('degrades gracefully when even the forced answer is a tool call', async () => {
    const model = new ScriptedModel(
      Array.from({ length: 5 }, () => '{"tool":"meeting_status","args":{}}'),
    );
    const result = await runAgent(
      [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hi' },
      ],
      { ...agentDefaults, maxSteps: 2, model, tools: MAIN_LIKE_TOOLS, context: baseContext() },
    );
    expect(result.answer).toContain('ran out of research steps');
    expect(result.answer).not.toContain('{');
  });

  it('rejects tools not in the allowed set', async () => {
    const model = new ScriptedModel([
      '{"tool":"write_artifact","args":{"name":"x","content":"y"}}',
      'done',
    ]);
    const result = await runAgent(
      [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hi' },
      ],
      { ...agentDefaults, model, tools: READ_ONLY_LIKE_TOOLS, context: baseContext() },
    );
    expect(result.toolInvocations[0].result).toContain('not available');
  });
});

/**
 * A model for scan tests: on a "map" call (window prompt) it returns a note
 * unless the window contains SKIP; on a "reduce" call it reports the note count.
 */
class ScanFakeModel implements LanguageModel {
  readonly contextWindow = 8192;
  mapCalls = 0;
  reduceCalls = 0;

  async countTokens(): Promise<number> {
    return 10;
  }

  async generate(turns: ChatTurn[]): Promise<string> {
    const system = turns[0]?.content ?? '';
    const user = turns[1]?.content ?? '';

    if (system.startsWith('You are combining')) {
      this.reduceCalls += 1;
      const lines = user
        .split('\n')
        .filter((line) => line.startsWith('['));
      return `combined(${lines.length})`;
    }

    this.mapCalls += 1;
    return user.includes('SKIP') ? 'NONE' : 'kept a note';
  }
}

function makeTranscript(count: number, skipIndices: number[] = []): Transcript {
  return {
    text: '',
    language: 'en',
    segments: Array.from({ length: count }, (_, index) => ({
      text: skipIndices.includes(index) ? 'SKIP me' : `content ${index}`,
      startSeconds: index,
      endSeconds: index + 1,
      speaker: 'SPEAKER_0',
      speakerName: 'Alice',
    })),
  };
}

describe('runRollingScan', () => {
  it('sweeps every window, skips NONE, and reduces the notes', async () => {
    const model = new ScanFakeModel();
    const events: number[] = [];
    // 10 segments, window 3, no overlap → 4 windows; segments 3-5 are SKIP.
    const result = await runRollingScan(
      model,
      makeTranscript(10, [3, 4, 5]),
      'note everything',
      { windowSize: 3, overlap: 0, maxWindows: 40 },
      { onWindow: (index) => events.push(index) },
    );

    expect(result.windowCount).toBe(4);
    expect(model.mapCalls).toBe(4);
    expect(events).toEqual([0, 1, 2, 3]);
    // Window [3-5] is all SKIP → no note; the other three windows contribute.
    expect(result.notes).toHaveLength(3);
    expect(result.answer).toBe('combined(3)');
  });

  it('enlarges windows to bound the count while covering the whole transcript', async () => {
    const model = new ScanFakeModel();
    const result = await runRollingScan(
      model,
      makeTranscript(100),
      'summarize',
      { windowSize: 3, overlap: 0, maxWindows: 10 },
    );

    // Window count is capped even though 100/3 would be ~34 small windows.
    expect(result.windowCount).toBeLessThanOrEqual(10);
    // Full coverage: the final note reaches the last segment.
    const lastNote = result.notes[result.notes.length - 1];
    expect(lastNote.endIndex).toBe(99);
  });

  it('handles an empty transcript without calling the model', async () => {
    const model = new ScanFakeModel();
    const result = await runRollingScan(model, makeTranscript(0), 'x', {});
    expect(model.mapCalls).toBe(0);
    expect(result.notes).toHaveLength(0);
    expect(result.windowCount).toBe(0);
  });
});

describe('buildMainSystemPrompt', () => {
  it('lists existing artifacts and steers toward reusing them before scanning', () => {
    const prompt = buildMainSystemPrompt(MAIN_TOOLS, baseContext(), [
      'scan-summary-abc123',
    ]);
    expect(prompt).toContain('scan-summary-abc123');
    expect(prompt).toContain('read_artifact');
    // Scanning is explicitly the last resort.
    expect(prompt.toLowerCase()).toContain('only when');
  });

  it('notes when no artifacts exist yet', () => {
    const prompt = buildMainSystemPrompt(MAIN_TOOLS, baseContext(), []);
    expect(prompt).toContain('No artifacts have been saved');
  });
});

describe('ChatService reuses existing artifacts', () => {
  it('lists artifacts when building the turn so the model can reuse them', async () => {
    const model = new ScriptedModel(['Answered from the existing summary.']);
    let listCalls = 0;
    const service = new ChatService(model, {
      makeId: () => 'id-x',
      now: () => 1000,
    });

    await service.runTurn({
      thread: {
        id: 't1',
        meetingId: 'm1',
        title: '',
        createdAt: 0,
        updatedAt: 0,
        messageCount: 0,
        transcriptStatus: 'finalized',
        messages: [],
      },
      userText: 'what were the key points?',
      transcript,
      transcriptStatus: 'finalized',
      meetingTitle: 'Planning',
      artifacts: {
        list: async () => {
          listCalls += 1;
          return ['scan-summary-abc123'];
        },
        read: async () => '# Summary\nkey points here',
        write: async (name) => name,
      },
      onEvent: () => undefined,
      persistDelegateLog: async () => undefined,
      persistScanLog: async () => undefined,
    });

    // The first generation's system prompt names the existing artifact.
    const firstPromptSystem = model.seen[0][0].content;
    expect(listCalls).toBeGreaterThan(0);
    expect(firstPromptSystem).toContain('scan-summary-abc123');
  });
});

describe('ChatService delegate output', () => {
  it('writes the delegate result to an artifact and returns a pointer, not the full answer', async () => {
    const model = new ScriptedModel([
      '{"tool":"delegate","args":{"task":"list decisions"}}',
      'Decision A at [0:00]; Decision B at [0:07].',
      'See the research artifact for the full list.',
    ]);
    const writes = new Map<string, string>();

    const service = new ChatService(model, {
      makeId: (() => {
        let n = 0;
        return () => `id-${n++}`;
      })(),
      now: () => 1000,
    });

    const input: RunChatTurnInput = {
      thread: {
        id: 'thread-1',
        meetingId: 'm1',
        title: '',
        createdAt: 0,
        updatedAt: 0,
        messageCount: 0,
        transcriptStatus: 'finalized',
        messages: [],
      },
      userText: 'What was decided?',
      transcript,
      transcriptStatus: 'finalized',
      meetingTitle: 'Planning',
      artifacts: {
        list: async () => [...writes.keys()],
        read: async (name) => writes.get(name) ?? null,
        write: async (name, content) => {
          writes.set(name, content);
          return name;
        },
      },
      onEvent: () => undefined,
      persistDelegateLog: async () => undefined,
      persistScanLog: async () => undefined,
    };

    const message = await service.runTurn(input);

    // The delegate wrote exactly one output artifact containing its answer.
    expect(writes.size).toBe(1);
    const [artifactName, artifactContent] = [...writes.entries()][0];
    expect(artifactName).toContain('research-list-decisions');
    expect(artifactContent).toContain('Decision A at [0:00]');

    // The main chat saw a pointer to the artifact, not the full delegate answer.
    const mainSecondPrompt = model.seen[model.seen.length - 1];
    const toolTurn = mainSecondPrompt.find((turn) => turn.role === 'tool');
    expect(toolTurn?.content).toContain(`artifact "${artifactName}"`);

    // The stored assistant message links the output artifact.
    expect(message.delegateRuns?.[0].outputArtifact).toBe(artifactName);
    expect(message.content).toBe('See the research artifact for the full list.');
  });
});

describe('resolveContextTokens', () => {
  it('is capped by the model window when memory is plentiful (16GB case)', () => {
    // ~13GB free for KV easily affords far more than a 32k window.
    const tokens = resolveContextTokens({
      modelContextWindow: 32768,
      cacheBudgetBytes: 13 * 1024 * 1024 * 1024,
    });
    expect(tokens).toBe(32768);
  });

  it('is capped by memory when the budget is tight', () => {
    const perToken = estimateKvCacheBytes({ contextTokens: 1 });
    const tokens = resolveContextTokens({
      modelContextWindow: 32768,
      cacheBudgetBytes: perToken * 5000,
    });
    expect(tokens).toBe(5000);
  });

  it('honors a hard cap (e.g. GPU-safe ceiling)', () => {
    const tokens = resolveContextTokens({
      modelContextWindow: 32768,
      cacheBudgetBytes: 13 * 1024 * 1024 * 1024,
      hardCap: 8192,
    });
    expect(tokens).toBe(8192);
  });

  it('never drops below the floor', () => {
    const tokens = resolveContextTokens({
      modelContextWindow: 32768,
      cacheBudgetBytes: 0,
      minTokens: 2048,
    });
    expect(tokens).toBe(2048);
  });
});

describe('MemoryBudget', () => {
  it('lets chat in when there is room', () => {
    const budget = new MemoryBudget(8_000_000_000);
    budget.register({ key: 'whisper', label: 'transcription', bytes: 1_000_000_000, evictable: false });
    const decision = budget.admitChat(2_000_000_000);
    expect(decision.ok).toBe(true);
  });

  it('refuses chat when the pipeline fills the budget (recording wins)', () => {
    const budget = new MemoryBudget(4_000_000_000);
    budget.register({ key: 'whisper', label: 'transcription', bytes: 3_500_000_000, evictable: false });
    const decision = budget.admitChat(2_000_000_000);
    expect(decision.ok).toBe(false);
    // The non-evictable pipeline allocation is never reclaimed.
    expect(budget.reclaimableBytes()).toBe(0);
  });

  it('counts a thread reclaiming its own prior allocation', () => {
    const budget = new MemoryBudget(4_000_000_000);
    budget.register({ key: 'chat', label: 'language', bytes: 3_000_000_000, evictable: true });
    const decision = budget.admitChat(3_000_000_000, ['chat']);
    expect(decision.ok).toBe(true);
  });
});

// Minimal tool sets mirroring chat-tools without importing the real definitions,
// so the agent test is isolated from prompt wording.
const MAIN_LIKE_TOOLS = [
  { name: 'meeting_status', description: '', usage: '' },
  { name: 'search_transcript', description: '', usage: '' },
  { name: 'read_transcript', description: '', usage: '' },
  { name: 'write_artifact', description: '', usage: '' },
];
const READ_ONLY_LIKE_TOOLS = [
  { name: 'meeting_status', description: '', usage: '' },
  { name: 'search_transcript', description: '', usage: '' },
];
