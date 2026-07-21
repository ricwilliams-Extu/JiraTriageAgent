import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockConnect, mockCallTool } = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockCallTool: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  // A regular function, not an arrow function — arrow functions aren't
  // constructible, and this mock is invoked via `new Client(...)`.
  Client: vi.fn().mockImplementation(function MockClient() {
    return { connect: mockConnect, callTool: mockCallTool };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function MockTransport() {
    return {};
  }),
}));

const { JiraMcpClient } = await import("./jiraMcpClient.js");

beforeEach(() => {
  mockConnect.mockReset().mockResolvedValue(undefined);
  mockCallTool.mockReset();
});

describe("JiraMcpClient", () => {
  it("returns the text content from a successful tool call", async () => {
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "hello" }] });
    const client = new JiraMcpClient({ baseDelayMs: 1 });

    const result = await client.callTool("jira_get_issue", { issue_key: "PROJ-1" });

    expect(result).toBe("hello");
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("reconnects and retries after a failed call, then succeeds", async () => {
    mockCallTool
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });
    const client = new JiraMcpClient({ baseDelayMs: 1 });

    const result = await client.callTool("jira_get_issue", { issue_key: "PROJ-1" });

    expect(result).toBe("ok");
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries", async () => {
    mockCallTool.mockRejectedValue(new Error("still broken"));
    const client = new JiraMcpClient({ baseDelayMs: 1, maxRetries: 2 });

    await expect(client.callTool("jira_get_issue", { issue_key: "PROJ-1" })).rejects.toThrow(
      "still broken",
    );
    expect(mockCallTool).toHaveBeenCalledTimes(3);
  });

  it("throws when the tool result has no text content block", async () => {
    mockCallTool.mockResolvedValue({ content: [] });
    const client = new JiraMcpClient({ baseDelayMs: 1, maxRetries: 0 });

    await expect(client.callTool("jira_get_issue", { issue_key: "PROJ-1" })).rejects.toThrow(
      /no text content/,
    );
  });
});
