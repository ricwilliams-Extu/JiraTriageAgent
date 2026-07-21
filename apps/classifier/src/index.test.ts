import { describe, expect, it, vi } from "vitest";
import type { Ticket } from "@jira-triage/shared-types";
import type { AnthropicCompletionClient } from "@jira-triage/anthropic-client";
import { ClassificationValidationError, classifyTicket } from "./index.js";

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    key: "PROJ-1",
    projectKey: "PROJ",
    summary: "Login button does nothing",
    description: "Clicking the login button on the homepage does nothing in Chrome.",
    reporter: "jdoe",
    createdAt: "2026-07-20T12:00:00.000Z",
    ...overrides,
  };
}

function mockClient(responseText: string): AnthropicCompletionClient {
  return { complete: vi.fn().mockResolvedValue(responseText) };
}

describe("classifyTicket", () => {
  it("returns a validated ClassificationResult on a well-formed model response", async () => {
    const client = mockClient(
      JSON.stringify({
        category: "bug",
        component: "auth",
        severity: "high",
        confidence: 0.87,
        duplicate_of: null,
        reasoning: "Login is broken for at least one user in Chrome.",
      }),
    );

    const result = await classifyTicket(makeTicket(), client);

    expect(result.category).toBe("bug");
    expect(result.component).toBe("auth");
    expect(result.confidence).toBeCloseTo(0.87);
    expect(result.duplicate_of).toBeNull();
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

  it("throws ClassificationValidationError when the model returns malformed JSON", async () => {
    const client = mockClient("this is not json at all");

    await expect(classifyTicket(makeTicket(), client)).rejects.toThrow(
      ClassificationValidationError,
    );
  });

  it("throws ClassificationValidationError when JSON is well-formed but fails the schema", async () => {
    const client = mockClient(
      JSON.stringify({
        category: "not-a-real-category",
        component: "auth",
        severity: "high",
        confidence: 2.5,
        duplicate_of: null,
        reasoning: "bad",
      }),
    );

    await expect(classifyTicket(makeTicket(), client)).rejects.toThrow(
      ClassificationValidationError,
    );
  });

  it("classifies a ticket with no description without throwing", async () => {
    const client = mockClient(
      JSON.stringify({
        category: "question",
        component: "unknown",
        severity: "low",
        confidence: 0.4,
        duplicate_of: null,
        reasoning: "Ticket has no description, low confidence.",
      }),
    );

    const result = await classifyTicket(makeTicket({ description: "" }), client);

    expect(result.category).toBe("question");
    expect(result.confidence).toBeLessThan(0.6);
  });
});
