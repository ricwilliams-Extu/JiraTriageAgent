import { z } from "zod";

// Phase 1 placeholder shape, deferred through Phase 3, evaluated for real in
// Phase 4 once mcp-atlassian was wired in: this shape holds up as-is. JIRA's
// real issue representation doesn't match 1:1 (reporter is an object,
// description/timestamp formats differ) — that adaptation happens in
// apps/coordinator/src/jira.ts's mapping layer, not here, so this stays the
// minimal internal domain shape Classifier/Research actually need. See
// CLAUDE.md's "Decisions made in Phase 4" for the full reasoning.
export const TicketSchema = z.object({
  key: z.string(),
  projectKey: z.string(),
  summary: z.string(),
  description: z.string(),
  reporter: z.string(),
  createdAt: z.string().datetime(),
});

export type Ticket = z.infer<typeof TicketSchema>;
