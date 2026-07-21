import pino from "pino";
import {
  ResearchResultSchema,
  type ClassificationResult,
  type ResearchResult,
  type Ticket,
} from "@jira-triage/shared-types";
import { AnthropicClient, type AnthropicCompletionClient } from "@jira-triage/anthropic-client";

const logger = pino({ name: "research" });

/**
 * Thrown when the Research subagent's model response can't be parsed as
 * JSON, or parses but doesn't match ResearchResultSchema. Per CLAUDE.md,
 * malformed subagent output must fail loudly rather than pass through.
 */
export class ResearchValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ResearchValidationError";
  }
}

const SYSTEM_PROMPT = `You are the Research subagent in a JIRA ticket triage system. You are given
a ticket and the Classifier's output for it. Return supporting context as a
single JSON object and nothing else.

Output exactly one JSON object matching this shape, with no markdown code
fences, no preamble, and no trailing commentary:

{
  "similar_resolved_tickets": string[],
  "relevant_docs": string[],
  "suggested_owner_team": string,
  "draft_response": string,
  "escalation_flag": boolean
}

Field guidance:
- similar_resolved_tickets: you have NOT been given a real search index of
  past tickets. Leave this empty ([]) unless the ticket text itself names
  another ticket key. Do NOT invent plausible-looking ticket keys — a
  fabricated key is worse than an empty list, since a human will trust it.
- relevant_docs: same rule — name a doc/runbook only if you have genuine
  general knowledge that such a resource exists for this kind of issue,
  otherwise leave empty.
- suggested_owner_team: infer from the category/component (e.g. security
  category -> "security-team", infra category -> "platform-team"). This is
  advisory; a human confirms real ownership.
- draft_response: a short, professional draft reply to the reporter
  acknowledging the issue and next steps. Do not promise a fix timeline.
- escalation_flag: true if this needs urgent human attention beyond normal
  triage — always true for category "security" or severity "critical", use
  judgement otherwise.

Return ONLY the JSON object.`;

function buildUserPrompt(ticket: Ticket, classification: ClassificationResult): string {
  return [
    `Ticket: ${ticket.key}`,
    `Project: ${ticket.projectKey}`,
    `Summary: ${ticket.summary}`,
    "Description:",
    ticket.description.trim().length > 0 ? ticket.description : "(no description provided)",
    "",
    "Classifier output:",
    `Category: ${classification.category}`,
    `Component: ${classification.component}`,
    `Severity: ${classification.severity}`,
    `Confidence: ${classification.confidence}`,
    `Duplicate of: ${classification.duplicate_of ?? "none"}`,
    `Reasoning: ${classification.reasoning}`,
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

export async function researchTicket(
  ticket: Ticket,
  classification: ClassificationResult,
  client: AnthropicCompletionClient = getSharedClient(),
): Promise<ResearchResult> {
  logger.info({ ticketKey: ticket.key }, "researching ticket");

  const raw = await client.complete({
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(ticket, classification),
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (error) {
    logger.error({ ticketKey: ticket.key, raw }, "research response was not valid JSON");
    throw new ResearchValidationError(
      `Research response for ticket ${ticket.key} was not valid JSON`,
      { cause: error },
    );
  }

  const result = ResearchResultSchema.safeParse(parsed);
  if (!result.success) {
    logger.error(
      { ticketKey: ticket.key, issues: result.error.issues, raw },
      "research response failed schema validation",
    );
    throw new ResearchValidationError(
      `Research response for ticket ${ticket.key} failed schema validation`,
      { cause: result.error },
    );
  }

  logger.info(
    { ticketKey: ticket.key, escalationFlag: result.data.escalation_flag },
    "ticket research complete",
  );
  return result.data;
}
