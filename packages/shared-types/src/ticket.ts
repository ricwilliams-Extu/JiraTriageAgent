import { z } from "zod";

// NOTE: not specified in CLAUDE.md's Data contracts section — this shape is
// a Phase 1 placeholder covering the minimum a JIRA webhook payload needs to
// carry into the Classifier. Revisit once real webhook payloads are wired up
// in Phase 3, and fold the agreed shape back into CLAUDE.md.
export const TicketSchema = z.object({
  key: z.string(),
  projectKey: z.string(),
  summary: z.string(),
  description: z.string(),
  reporter: z.string(),
  createdAt: z.string().datetime(),
});

export type Ticket = z.infer<typeof TicketSchema>;
