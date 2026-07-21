import { z } from "zod";

export const ResearchResultSchema = z.object({
  similar_resolved_tickets: z.array(z.string()),
  relevant_docs: z.array(z.string()),
  suggested_owner_team: z.string(),
  draft_response: z.string(),
  escalation_flag: z.boolean(),
});

export type ResearchResult = z.infer<typeof ResearchResultSchema>;
