import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";

const logger = pino({ name: "coordinator" });

const DEFAULT_URL = "http://mcp-atlassian:8000/mcp";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;

export interface JiraMcpClientConfig {
  url?: string;
  maxRetries?: number;
  baseDelayMs?: number;
}

/**
 * Narrow interface `jira.ts` depends on, so tests can inject a mock without
 * touching the real MCP SDK — mirrors `AnthropicCompletionClient` in
 * packages/anthropic-client.
 */
export interface JiraMcpClientLike {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlock = content.find(
    (block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
  );
  if (!textBlock) {
    throw new Error("mcp-atlassian tool call returned no text content");
  }
  return textBlock.text;
}

/**
 * Thin wrapper around the MCP client connection to the mcp-atlassian sidecar,
 * reached over the docker-compose network by service name (never `localhost`
 * — that only applies once Coordinator and the sidecar share a single Azure
 * Container App, a Phase 6 deploy-time concern).
 *
 * Two layers of resilience, deliberately not one: `StreamableHTTPClientTransport`
 * has its own built-in reconnection for the underlying SSE stream dropping
 * (`reconnectionOptions` below). That doesn't cover a `callTool()` request
 * itself failing outright, so `callTool` here also retries explicitly with
 * backoff, discarding and re-establishing the cached connection on failure —
 * mirroring the retry design already used in `packages/anthropic-client`.
 */
export class JiraMcpClient implements JiraMcpClientLike {
  private client: Client | undefined;
  private readonly url: string;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;

  constructor(config: JiraMcpClientConfig = {}) {
    this.url = config.url ?? process.env.MCP_ATLASSIAN_URL ?? DEFAULT_URL;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  }

  private async connect(): Promise<Client> {
    const client = new Client({ name: "jira-triage-coordinator", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      reconnectionOptions: {
        maxReconnectionDelay: 30_000,
        initialReconnectionDelay: 1_000,
        reconnectionDelayGrowFactor: 1.5,
        maxRetries: 5,
      },
    });
    transport.onerror = (error) => {
      logger.error({ err: error }, "mcp-atlassian transport error");
    };
    await client.connect(transport);
    return client;
  }

  // Note: not concurrency-hardened — two calls racing on the very first
  // connection could each establish their own Client before either is
  // cached. Acceptable for this phase's traffic (one webhook at a time);
  // worth a real connection lock if that changes.
  private async getClient(): Promise<Client> {
    this.client ??= await this.connect();
    return this.client;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    let attempt = 0;
    for (;;) {
      try {
        const client = await this.getClient();
        const result = await client.callTool({ name, arguments: args });
        return extractText(result);
      } catch (error) {
        attempt += 1;
        this.client = undefined;
        if (attempt > this.maxRetries) {
          throw error;
        }
        logger.warn(
          { tool: name, attempt, err: error },
          "mcp-atlassian tool call failed, retrying",
        );
        await sleep(this.baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
}
