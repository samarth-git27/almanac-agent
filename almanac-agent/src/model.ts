/**
 * A deliberately tiny model interface. The agent loop depends on this, not on the SDK, so the
 * whole loop can be tested offline with a scripted model, and swapping providers is one adapter.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Opaque provider data that must round-trip with the block (Gemini thought signatures). Never sent to other providers. */
  providerMeta?: unknown;
}

/** An API failure with the HTTP status preserved, so the agent can explain it kindly. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export type Block = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: string | Block[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface SystemPart {
  text: string;
  /** cache breakpoint: everything up to and including this part (tools + system) is prefix-cached */
  cache?: boolean;
}

export interface ModelRequest {
  system: SystemPart[];
  messages: Message[];
  tools: ToolDef[];
  /** false = the model must answer in text (used on the last round so every turn ends in an answer) */
  allowTools: boolean;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelResponse {
  content: (TextBlock | ToolUseBlock)[];
  stopReason: string;
  usage: Usage;
}

export interface ChatModel {
  complete(req: ModelRequest, onText?: (delta: string) => void): Promise<ModelResponse>;
}

export class AnthropicModel implements ChatModel {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
  ) {}

  async complete(req: ModelRequest, onText?: (delta: string) => void): Promise<ModelResponse> {
    const hasTools = req.tools.length > 0;
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: req.maxTokens,
        system: req.system.map((p) => ({
          type: 'text' as const,
          text: p.text,
          ...(p.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
        })),
        messages: req.messages.map((m) => ({
          role: m.role,
          content:
            typeof m.content === 'string'
              ? m.content
              : m.content.map((b) => {
                  if (b.type !== 'tool_use') return b;
                  const { providerMeta: _meta, ...rest } = b;
                  return rest;
                }),
        })) as Anthropic.MessageParam[],
        ...(hasTools
          ? {
              tools: req.tools as Anthropic.Tool[],
              tool_choice: req.allowTools ? ({ type: 'auto' } as const) : ({ type: 'none' } as const),
            }
          : {}),
      },
      req.signal ? { signal: req.signal } : undefined,
    );
    if (onText) stream.on('text', (d) => onText(d));
    const msg = await stream.finalMessage();

    const content: ModelResponse['content'] = [];
    for (const b of msg.content) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use') {
        content.push({ type: 'tool_use', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
      }
    }
    return {
      content,
      stopReason: msg.stop_reason ?? 'end_turn',
      usage: {
        input: msg.usage.input_tokens ?? 0,
        output: msg.usage.output_tokens ?? 0,
        cacheRead: msg.usage.cache_read_input_tokens ?? 0,
        cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
