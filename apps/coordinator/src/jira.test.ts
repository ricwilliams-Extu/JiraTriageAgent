import { describe, expect, it, vi } from "vitest";
import type { Ticket, TriageDecision } from "@jira-triage/shared-types";
import type { JiraMcpClientLike } from "./jiraMcpClient.js";
import { JiraFetchError, JiraWriteError, fetchTicket, writeBackToJira } from "./jira.js";

function makeDecision(overrides: Partial<TriageDecision> = {}): TriageDecision {
  return {
    ticketKey: "PROJ-1",
    outcome: "auto-routed",
    classification: null,
    research: null,
    reasoning: "test reasoning",
    ...overrides,
  };
}

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    key: "PROJ-1",
    projectKey: "PROJ",
    summary: "x",
    description: "y",
    reporter: "z",
    createdAt: "2024-01-15T09:30:00.000Z",
    ...overrides,
  };
}

describe("fetchTicket", () => {
  it("fetches and maps a real-shaped jira_get_issue response into a Ticket", async () => {
    const raw = JSON.stringify({
      key: "PROJ-1",
      fields: {
        summary: "Login broken",
        description: "Steps to reproduce...",
        created: "2024-01-15T09:30:00.000+0000",
        project: { key: "PROJ" },
        reporter: { displayName: "Jane Doe", accountId: "abc123" },
      },
    });
    const client: JiraMcpClientLike = { callTool: vi.fn().mockResolvedValue(raw) };

    const ticket = await fetchTicket("PROJ-1", client);

    expect(ticket.key).toBe("PROJ-1");
    expect(ticket.projectKey).toBe("PROJ");
    expect(ticket.reporter).toBe("Jane Doe");
    expect(ticket.description).toBe("Steps to reproduce...");
    expect(client.callTool).toHaveBeenCalledWith("jira_get_issue", { issue_key: "PROJ-1" });
  });

  it("falls back through reporter fields when displayName is absent", async () => {
    const raw = JSON.stringify({
      key: "PROJ-2",
      fields: {
        summary: "x",
        created: "2024-01-15T09:30:00.000+0000",
        project: { key: "PROJ" },
        reporter: { accountId: "acc-only" },
      },
    });
    const client: JiraMcpClientLike = { callTool: vi.fn().mockResolvedValue(raw) };

    const ticket = await fetchTicket("PROJ-2", client);

    expect(ticket.reporter).toBe("acc-only");
  });

  it("normalizes Jira's non-colon UTC offset timestamp to a strict ISO string", async () => {
    const raw = JSON.stringify({
      key: "PROJ-1",
      fields: {
        summary: "x",
        created: "2024-01-15T09:30:00.000+0000",
        project: { key: "PROJ" },
      },
    });
    const client: JiraMcpClientLike = { callTool: vi.fn().mockResolvedValue(raw) };

    const ticket = await fetchTicket("PROJ-1", client);

    expect(ticket.createdAt).toBe(new Date("2024-01-15T09:30:00.000+0000").toISOString());
  });

  it("throws JiraFetchError when the response is not valid JSON", async () => {
    const client: JiraMcpClientLike = { callTool: vi.fn().mockResolvedValue("not json") };

    await expect(fetchTicket("PROJ-1", client)).rejects.toThrow(JiraFetchError);
  });

  it("throws JiraFetchError when the response doesn't match the expected shape", async () => {
    const client: JiraMcpClientLike = {
      callTool: vi.fn().mockResolvedValue(JSON.stringify({ nope: true })),
    };

    await expect(fetchTicket("PROJ-1", client)).rejects.toThrow(JiraFetchError);
  });

  it("throws JiraFetchError when the underlying tool call itself fails", async () => {
    const client: JiraMcpClientLike = {
      callTool: vi.fn().mockRejectedValue(new Error("connection refused")),
    };

    await expect(fetchTicket("PROJ-1", client)).rejects.toThrow(JiraFetchError);
  });
});

describe("writeBackToJira", () => {
  it("comments and merges the outcome label without dropping existing labels", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const client: JiraMcpClientLike = {
      callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "jira_get_issue") {
          return JSON.stringify({
            key: "PROJ-1",
            fields: {
              summary: "x",
              created: "2024-01-15T09:30:00.000+0000",
              project: { key: "PROJ" },
              labels: ["existing-label"],
            },
          });
        }
        return "{}";
      }),
    };

    await writeBackToJira(makeTicket(), makeDecision(), client);

    const commentCall = calls.find((c) => c.name === "jira_add_comment");
    const updateCall = calls.find((c) => c.name === "jira_update_issue");
    expect(commentCall?.args.body).toContain("test reasoning");
    expect(updateCall?.args.fields).toEqual({
      labels: ["existing-label", "triage:auto-routed"],
    });
  });

  it("includes the research draft response in the comment when present", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const client: JiraMcpClientLike = {
      callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "jira_get_issue") {
          return JSON.stringify({
            key: "PROJ-1",
            fields: {
              summary: "x",
              created: "2024-01-15T09:30:00.000+0000",
              project: { key: "PROJ" },
            },
          });
        }
        return "{}";
      }),
    };

    await writeBackToJira(
      makeTicket(),
      makeDecision({
        research: {
          similar_resolved_tickets: [],
          relevant_docs: [],
          suggested_owner_team: "auth-team",
          draft_response: "Thanks, we're on it.",
          escalation_flag: false,
        },
      }),
      client,
    );

    const commentCall = calls.find((c) => c.name === "jira_add_comment");
    expect(commentCall?.args.body).toContain("Thanks, we're on it.");
  });

  it("throws JiraWriteError when the underlying tool call fails", async () => {
    const client: JiraMcpClientLike = { callTool: vi.fn().mockRejectedValue(new Error("boom")) };

    await expect(writeBackToJira(makeTicket(), makeDecision(), client)).rejects.toThrow(
      JiraWriteError,
    );
  });
});
