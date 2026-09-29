// Provider interface (GOAL §3). All Claude-specific logic lives in provider/claude/.

export type Frame =
  | { type: 'init'; sessionId: string; apiKeySource: string; model: string; tools: string[] }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; output: string; ok: boolean }
  | { type: 'rate_limit'; fiveHour?: number; sevenDay?: number; status?: string; raw: unknown }
  | { type: 'done'; sessionId: string; text: string; isError: boolean; durationMs: number; costUsd?: number }
  | { type: 'error'; message: string }

export interface CustomTool {
  name: string
  description: string
  // JSON-schema-ish shape is provider-specific; we use zod in the Claude adapter.
  schema: Record<string, unknown>
  handler: (input: any) => Promise<{ ok: boolean; text: string }>
}

export interface OneShotRequest {
  system: string
  prompt: string
  model: string
  signal: AbortSignal
}

export interface ChatRequest {
  system: string
  prompt: string
  model: string
  cwd: string
  /** Stable key for the persistent process (one per document). */
  conversationKey: string
  sessionId?: string
  tools: CustomTool[]
  signal: AbortSignal
}

export interface Provider {
  id: string
  listModels(): Promise<{ id: string; label: string }[]>
  probeAuth(): Promise<{ ok: boolean; usingApiKey: boolean; detail: string }>
  /** Stateless, no tools, strict output — surgical lane. */
  oneShot(req: OneShotRequest): AsyncIterable<Frame>
  /** Persistent, tools available, resumable — chat lane. */
  chat(req: ChatRequest): AsyncIterable<Frame>
  /** Drop the persistent chat process for a conversation (e.g. instruction set changed). */
  endChat(conversationKey: string): Promise<void>
  shutdown(): Promise<void>
}
