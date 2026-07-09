/** Streaming events the chat engine emits so the UI can render activity live. */
export type ChatEvent =
  | { type: 'token'; text: string }
  | { type: 'tool-start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool-end'; id: string; result: string }
  | { type: 'delegate-start'; delegateId: string; task: string }
  | { type: 'delegate-step'; delegateId: string; index: number; tool: string }
  | {
      type: 'delegate-end';
      delegateId: string;
      answer: string;
      steps: number;
      artifact?: string;
    }
  | { type: 'scan-start'; scanId: string; instruction: string; totalWindows: number }
  | { type: 'scan-progress'; scanId: string; index: number; total: number }
  | {
      type: 'scan-end';
      scanId: string;
      noteCount: number;
      windowCount: number;
      artifact?: string;
    }
  | { type: 'notice'; text: string };
