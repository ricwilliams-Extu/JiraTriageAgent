import Anthropic, { APIConnectionError, APIError } from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;

export interface AnthropicCompletionRequest {
  system: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
}

/**
 * Narrow interface the subagents depend on, so tests (and future callers)
 * can supply a mock without touching the real Anthropic SDK.
 */
export interface AnthropicCompletionClient {
  complete(request: AnthropicCompletionRequest): Promise<string>;
}

export interface AnthropicClientConfig {
  apiKey?: string;
  model?: string;
  maxRetries?: number;
  baseDelayMs?: number;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof APIConnectionError) return true;
  if (error instanceof APIError) {
    return error.status === 429 || (typeof error.status === "number" && error.status >= 500);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractText(response: Anthropic.Message): string {
  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );
  if (!textBlock) {
    throw new Error("Anthropic response contained no text content block");
  }
  return textBlock.text;
}

/**
 * Thin, generic wrapper around the Anthropic Messages API. Retries transient
 * failures (rate limits, 5xx, connection errors) with exponential backoff.
 * Carries no Classifier/Research-specific logic — callers own their prompts
 * and response parsing.
 */
export class AnthropicClient implements AnthropicCompletionClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;

  constructor(config: AnthropicClientConfig = {}) {
    // maxRetries: 0 — retries are handled explicitly below so callers get
    // predictable, observable backoff instead of the SDK's built-in retry.
    this.client = new Anthropic({ apiKey: config.apiKey, maxRetries: 0 });
    this.model = config.model ?? DEFAULT_MODEL;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  }

  async complete(request: AnthropicCompletionRequest): Promise<string> {
    let attempt = 0;
    for (;;) {
      try {
        const response = await this.client.messages.create({
          model: request.model ?? this.model,
          max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: request.system,
          messages: [{ role: "user", content: request.prompt }],
        });
        return extractText(response);
      } catch (error) {
        attempt += 1;
        if (attempt > this.maxRetries || !isRetryable(error)) {
          throw error;
        }
        await sleep(this.baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
}
