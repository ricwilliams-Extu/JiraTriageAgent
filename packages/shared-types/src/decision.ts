import { z } from "zod";
import { ClassificationResultSchema } from "./classification.js";
import { ResearchResultSchema } from "./research.js";

export const TriageOutcomeSchema = z.enum([
  "auto-routed",
  "needs-human-triage",
  "duplicate-short-circuit",
  "security-escalation",
]);

export type TriageOutcome = z.infer<typeof TriageOutcomeSchema>;

export const TriageDecisionSchema = z.object({
  ticketKey: z.string(),
  outcome: TriageOutcomeSchema,
  classification: ClassificationResultSchema.nullable(),
  research: ResearchResultSchema.nullable(),
  reasoning: z.string(),
});

export type TriageDecision = z.infer<typeof TriageDecisionSchema>;
