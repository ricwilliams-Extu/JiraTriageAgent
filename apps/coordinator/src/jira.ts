import pino from "pino";
import type { Ticket, TriageDecision } from "@jira-triage/shared-types";

const logger = pino({ name: "coordinator" });

/**
 * TODO(Phase 4): replace with a real mcp-atlassian call that fetches the
 * ticket's summary/description/reporter/etc. from JIRA by key. Phase 3 has
 * no JIRA access, so this always returns a mocked Ticket built from the key.
 */
export async function fetchTicket(ticketKey: string): Promise<Ticket> {
  logger.warn(
    { ticketKey },
    "fetchTicket is a Phase 3 stub — returning a mocked ticket, no real JIRA call made",
  );
  return {
    key: ticketKey,
    projectKey: ticketKey.split("-")[0] ?? "UNKNOWN",
    summary: `Stubbed summary for ${ticketKey}`,
    description: `Stubbed description for ${ticketKey}. Real ticket content arrives via mcp-atlassian in Phase 4.`,
    reporter: "unknown-reporter",
    createdAt: new Date().toISOString(),
  };
}

/**
 * TODO(Phase 4): replace with real mcp-atlassian calls — comment, label,
 * and/or assign based on decision.outcome. Per CLAUDE.md, this must remain
 * the only place in the Coordinator that writes to JIRA; classifyTicket()
 * and researchTicket() must never grow write-side logic of their own.
 */
export async function writeBackToJira(ticket: Ticket, decision: TriageDecision): Promise<void> {
  logger.info(
    { ticketKey: ticket.key, outcome: decision.outcome },
    "writeBackToJira is a Phase 3 stub — logging the intended JIRA write, no real call made",
  );
}
