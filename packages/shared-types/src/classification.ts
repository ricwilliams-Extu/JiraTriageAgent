import { z } from "zod";

export const ClassificationResultSchema = z.object({
  category: z.enum(["bug", "feature-request", "question", "infra", "security"]),
  component: z.string(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  confidence: z.number().min(0).max(1),
  duplicate_of: z.string().nullable(),
  reasoning: z.string(),
});

export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;
