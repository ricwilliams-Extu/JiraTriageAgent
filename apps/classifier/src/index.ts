import pino from "pino";
import {
  ClassificationResultSchema,
  type ClassificationResult,
  type Ticket,
} from "@jira-triage/shared-types";
import { AnthropicClient, type AnthropicCompletionClient } from "@jira-triage/anthropic-client";

const logger = pino({ name: "classifier" });

/**
 * Thrown when the Classifier's model response can't be parsed as JSON, or
 * parses but doesn't match ClassificationResultSchema. Per CLAUDE.md,
 * malformed subagent output must fail loudly rather than pass through.
 */
export class ClassificationValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClassificationValidationError";
  }
}

const SYSTEM_PROMPT = `You are the Classifier subagent in a JIRA ticket triage system. Given a raw
JIRA ticket, return structured metadata as a single JSON object and nothing else.

Output exactly one JSON object matching this shape, with no markdown code
fences, no preamble, and no trailing commentary:

{
  "category": "bug" | "feature-request" | "question" | "infra" | "security",
  "component": string,
  "severity": "critical" | "high" | "medium" | "low",
  "confidence": number between 0.0 and 1.0,
  "duplicate_of": string ticket key (e.g. "PROJ-123") or null,
  "reasoning": string
}

Field guidance:
- category: pick the single best fit. "security" covers anything with a
  security, privacy, or data-exposure implication — when in doubt between
  security and another category, prefer security.
- component: your best guess at the affected system/module/area based on
  the ticket text (e.g. "auth", "billing", "api-gateway"). Use "unknown"
  if the ticket gives no signal.
- severity: judge from the user-visible impact described in the ticket,
  not from the reporter's own urgency claims alone.
- confidence: your genuine confidence in this classification as a whole,
  0.0-1.0. Lower confidence for vague, incomplete, or ambiguous tickets.
- duplicate_of: you have NOT been given other tickets to compare against.
  Only set this if the ticket text itself explicitly references another
  ticket key as a duplicate (e.g. "duplicate of PROJ-123", "same as
  PROJ-45"). Otherwise this MUST be null — do not guess or invent a
  ticket key.
- reasoning: 1-3 sentences explaining the classification, for a human
  reviewer.

Return ONLY the JSON object.`;

function buildUserPrompt(ticket: Ticket): string {
  return [
    `Ticket: ${ticket.key}`,
    `Project: ${ticket.projectKey}`,
    `Reporter: ${ticket.reporter}`,
    `Created: ${ticket.createdAt}`,
    `Summary: ${ticket.summary}`,
    "Description:",
    ticket.description.trim().length > 0 ? ticket.description : "(no description provided)",
  ].join("\n");
}

function extractJson(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : text.trim();
}

let sharedClient: AnthropicCompletionClient | undefined;
function getSharedClient(): AnthropicCompletionClient {
  sharedClient ??= new AnthropicClient();
  return sharedClient;
}

export async function classifyTicket(
  ticket: Ticket,
  client: AnthropicCompletionClient = getSharedClient(),
): Promise<ClassificationResult> {
  logger.info({ ticketKey: ticket.key }, "classifying ticket");

  const raw = await client.complete({
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(ticket),
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (error) {
    logger.error({ ticketKey: ticket.key, raw }, "classifier response was not valid JSON");
    throw new ClassificationValidationError(
      `Classifier response for ticket ${ticket.key} was not valid JSON`,
      { cause: error },
    );
  }

  const result = ClassificationResultSchema.safeParse(parsed);
  if (!result.success) {
    logger.error(
      { ticketKey: ticket.key, issues: result.error.issues, raw },
      "classifier response failed schema validation",
    );
    throw new ClassificationValidationError(
      `Classifier response for ticket ${ticket.key} failed schema validation`,
      { cause: result.error },
    );
  }

  logger.info(
    { ticketKey: ticket.key, category: result.data.category, severity: result.data.severity },
    "ticket classified",
  );
  return result.data;
}
