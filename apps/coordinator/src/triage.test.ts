import { describe, expect, it, vi } from "vitest";
import type { ClassificationResult, ResearchResult, Ticket } from "@jira-triage/shared-types";
import { ClassificationValidationError } from "@jira-triage/classifier";
import { ResearchValidationError } from "@jira-triage/research";
import { triageTicket } from "./triage.js";

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
    confidence: 0.9,
    duplicate_of: null,
    reasoning: "Looks like a genuine login regression.",
    ...overrides,
  };
}

function makeResearch(overrides: Partial<ResearchResult> = {}): ResearchResult {
  return {
    similar_resolved_tickets: [],
    relevant_docs: [],
    suggested_owner_team: "auth-team",
    draft_response: "Thanks for the report, we're looking into it.",
    escalation_flag: false,
    ...overrides,
  };
}

describe("triageTicket", () => {
  it("auto-routes a confident, non-duplicate, non-security ticket", async () => {
    const classify = vi.fn().mockResolvedValue(makeClassification());
    const research = vi.fn().mockResolvedValue(makeResearch());

    const decision = await triageTicket(makeTicket(), { classify, research });

    expect(decision.outcome).toBe("auto-routed");
    expect(decision.classification).not.toBeNull();
    expect(decision.research).not.toBeNull();
    expect(classify).toHaveBeenCalledTimes(1);
    expect(research).toHaveBeenCalledTimes(1);
  });

  it("short-circuits on a high-confidence duplicate and never calls research", async () => {
    const classify = vi
      .fn()
      .mockResolvedValue(makeClassification({ duplicate_of: "PROJ-42", confidence: 0.95 }));
    const research = vi.fn();

    const decision = await triageTicket(makeTicket(), { classify, research });

    expect(decision.outcome).toBe("duplicate-short-circuit");
    expect(decision.research).toBeNull();
    expect(decision.reasoning).toContain("PROJ-42");
    expect(research).not.toHaveBeenCalled();
  });

  it("proceeds with full triage when duplicate_of is set below the short-circuit threshold", async () => {
    const classify = vi
      .fn()
      .mockResolvedValue(makeClassification({ duplicate_of: "PROJ-42", confidence: 0.5 }));
    const research = vi.fn().mockResolvedValue(makeResearch());

    const decision = await triageTicket(makeTicket(), { classify, research });

    expect(research).toHaveBeenCalledTimes(1);
    expect(decision.outcome).toBe("needs-human-triage");
    expect(decision.reasoning).toContain("PROJ-42");
  });

  it("escalates a security-category ticket regardless of confidence", async () => {
    const classify = vi
      .fn()
      .mockResolvedValue(makeClassification({ category: "security", confidence: 0.95 }));
    const research = vi.fn().mockResolvedValue(makeResearch({ escalation_flag: true }));

    const decision = await triageTicket(makeTicket(), { classify, research });

    expect(decision.outcome).toBe("security-escalation");
    expect(research).toHaveBeenCalledTimes(1);
  });

  it("routes a low-confidence ticket to needs-human-triage", async () => {
    const classify = vi.fn().mockResolvedValue(makeClassification({ confidence: 0.4 }));
    const research = vi.fn().mockResolvedValue(makeResearch());

    const decision = await triageTicket(makeTicket(), { classify, research });

    expect(decision.outcome).toBe("needs-human-triage");
  });

  it("routes to needs-human-triage when classification fails validation, without calling research", async () => {
    const classify = vi
      .fn()
      .mockRejectedValue(new ClassificationValidationError("bad classification"));
    const research = vi.fn();

    const decision = await triageTicket(makeTicket(), { classify, research });

    expect(decision.outcome).toBe("needs-human-triage");
    expect(decision.classification).toBeNull();
    expect(decision.research).toBeNull();
    expect(research).not.toHaveBeenCalled();
  });

  it("routes to needs-human-triage when research fails validation", async () => {
    const classify = vi.fn().mockResolvedValue(makeClassification());
    const research = vi.fn().mockRejectedValue(new ResearchValidationError("bad research"));

    const decision = await triageTicket(makeTicket(), { classify, research });

    expect(decision.outcome).toBe("needs-human-triage");
    expect(decision.classification).not.toBeNull();
    expect(decision.research).toBeNull();
  });

  it("rethrows unexpected errors from classify rather than reframing them as low-quality triage", async () => {
    const classify = vi.fn().mockRejectedValue(new Error("network blip"));
    const research = vi.fn();

    await expect(triageTicket(makeTicket(), { classify, research })).rejects.toThrow(
      "network blip",
    );
    expect(research).not.toHaveBeenCalled();
  });
});
