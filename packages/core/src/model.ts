import type { ModelProvider, ModelRequest, ModelResponse, ToolCall } from "./types.ts";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  fallbackModel?: string;
  timeoutMs?: number;
}

interface OpenRouterBody {
  model?: string;
  choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { code?: number | string; message?: string };
}

export class OpenRouterProvider implements ModelProvider {
  private readonly config: OpenRouterConfig;

  constructor(config: OpenRouterConfig) {
    this.config = config;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const { apiKey, model, fallbackModel, timeoutMs = 30_000 } = this.config;
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        models: fallbackModel ? [model, fallbackModel] : [model],
        messages: request.messages,
        tools: request.tools,
        tool_choice: "auto",
        response_format: {
          type: "json_schema",
          json_schema: { name: "bot_answer", strict: true, schema: request.schema },
        },
        // Skip providers that would drop tools or JSON schema, or that collect data.
        provider: { require_parameters: true, data_collection: "deny" },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json().catch(() => ({}))) as OpenRouterBody;
    if (!response.ok || body.error) {
      throw new Error(`openrouter_error: ${body.error?.message ?? response.status}`);
    }
    const message = body.choices?.[0]?.message;
    return {
      content: message?.content ?? null,
      tool_calls: message?.tool_calls ?? [],
      usage: {
        prompt_tokens: body.usage?.prompt_tokens ?? 0,
        completion_tokens: body.usage?.completion_tokens ?? 0,
        cost: body.usage?.cost ?? null,
      },
      model: body.model ?? model,
    };
  }
}
