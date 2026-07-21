import { describe, expect, it, vi } from "vitest";
import type { ClassificationResult, Ticket } from "@jira-triage/shared-types";
import type { AnthropicCompletionClient } from "@jira-triage/anthropic-client";
import { ResearchValidationError, researchTicket } from "./index.js";

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

function makeClassification(overrides: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    category: "bug",
    component: "auth",
    severity: "medium",
    confidence: 0.8,
    duplicate_of: null,
    reasoning: "Looks like a genuine login regression.",
    ...overrides,
  };
}

function mockClient(responseText: string): AnthropicCompletionClient {
  return { complete: vi.fn().mockResolvedValue(responseText) };
}

describe("researchTicket", () => {
  it("returns a validated ResearchResult on a well-formed model response", async () => {
    const client = mockClient(
      JSON.stringify({
        similar_resolved_tickets: ["PROJ-88"],
        relevant_docs: ["Auth Runbook"],
        suggested_owner_team: "auth-team",
        draft_response: "Thanks for the report, we're looking into it.",
        escalation_flag: false,
      }),
    );

    const result = await researchTicket(makeTicket(), makeClassification(), client);

    expect(result.suggested_owner_team).toBe("auth-team");
    expect(result.similar_resolved_tickets).toEqual(["PROJ-88"]);
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

  it("throws ResearchValidationError when the model returns malformed JSON", async () => {
    const client = mockClient("nope, not json");

    await expect(researchTicket(makeTicket(), makeClassification(), client)).rejects.toThrow(
      ResearchValidationError,
    );
  });

  it("throws ResearchValidationError when JSON is well-formed but fails the schema", async () => {
    const client = mockClient(
      JSON.stringify({
        similar_resolved_tickets: "not-an-array",
        relevant_docs: [],
        suggested_owner_team: "auth-team",
        draft_response: "x",
        escalation_flag: false,
      }),
    );

    await expect(researchTicket(makeTicket(), makeClassification(), client)).rejects.toThrow(
      ResearchValidationError,
    );
  });

  it("handles a critical-severity, security classification", async () => {
    const client = mockClient(
      JSON.stringify({
        similar_resolved_tickets: [],
        relevant_docs: [],
        suggested_owner_team: "security-team",
        draft_response: "Escalating this immediately to the security team.",
        escalation_flag: true,
      }),
    );

    const result = await researchTicket(
      makeTicket(),
      makeClassification({ category: "security", severity: "critical" }),
      client,
    );

    expect(result.escalation_flag).toBe(true);
    expect(result.suggested_owner_team).toBe("security-team");
  });
});
