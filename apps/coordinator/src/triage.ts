import pino from "pino";
import type {
  ClassificationResult,
  ResearchResult,
  Ticket,
  TriageDecision,
} from "@jira-triage/shared-types";
import { classifyTicket, ClassificationValidationError } from "@jira-triage/classifier";
import { researchTicket, ResearchValidationError } from "@jira-triage/research";

const logger = pino({ name: "coordinator" });

const DUPLICATE_CONFIDENCE_THRESHOLD = 0.8;
const LOW_CONFIDENCE_THRESHOLD = 0.6;

export interface TriageDependencies {
  classify?: typeof classifyTicket;
  research?: typeof researchTicket;
}

function decide(
  ticket: Ticket,
  classification: ClassificationResult | null,
  research: ResearchResult | null,
  outcome: TriageDecision["outcome"],
  reasoning: string,
): TriageDecision {
  return {
    ticketKey: ticket.key,
    outcome,
    classification,
    research,
    reasoning,
  };
}

/**
 * Pure orchestration: classify, then (usually) research, then apply
 * CLAUDE.md's business rules to a final routing decision. HTTP-agnostic —
 * the webhook route in index.ts is the only piece aware of Express.
 *
 * Only ClassificationValidationError/ResearchValidationError are caught and
 * converted into a "needs-human-triage" decision. Any other error (e.g. a
 * network failure) is a genuine unexpected failure, not a data-quality
 * problem, so it's rethrown for the caller to handle as an actual error
 * rather than being silently reframed as low-quality triage output.
 */
export async function triageTicket(
  ticket: Ticket,
  deps: TriageDependencies = {},
): Promise<TriageDecision> {
  const classify = deps.classify ?? classifyTicket;
  const research = deps.research ?? researchTicket;

  let classification: ClassificationResult;
  try {
    classification = await classify(ticket);
  } catch (error) {
    if (error instanceof ClassificationValidationError) {
      logger.error(
        { ticketKey: ticket.key, err: error },
        "classification failed validation, routing to human triage",
      );
      return decide(
        ticket,
        null,
        null,
        "needs-human-triage",
        `Classifier output failed validation: ${error.message}`,
      );
    }
    throw error;
  }

  // Duplicate short-circuit takes precedence over everything below,
  // including security escalation — CLAUDE.md's business rules condition
  // this only on duplicate_of + confidence, with no category exception, and
  // require it to happen before Research is even called.
  if (
    classification.duplicate_of !== null &&
    classification.confidence >= DUPLICATE_CONFIDENCE_THRESHOLD
  ) {
    logger.info(
      { ticketKey: ticket.key, duplicateOf: classification.duplicate_of },
      "duplicate short-circuit, skipping research",
    );
    return decide(
      ticket,
      classification,
      null,
      "duplicate-short-circuit",
      `Classifier flagged this as a duplicate of ${classification.duplicate_of} at confidence ` +
        `${classification.confidence}, meeting the ${DUPLICATE_CONFIDENCE_THRESHOLD} short-circuit ` +
        "threshold. Research was skipped.",
    );
  }

  const duplicateNote =
    classification.duplicate_of !== null
      ? ` Classifier also flagged a possible duplicate of ${classification.duplicate_of} at confidence ` +
        `${classification.confidence}, below the ${DUPLICATE_CONFIDENCE_THRESHOLD} short-circuit threshold, ` +
        "so full triage proceeded."
      : "";

  let researchResult: ResearchResult;
  try {
    researchResult = await research(ticket, classification);
  } catch (error) {
    if (error instanceof ResearchValidationError) {
      logger.error(
        { ticketKey: ticket.key, err: error },
        "research failed validation, routing to human triage",
      );
      return decide(
        ticket,
        classification,
        null,
        "needs-human-triage",
        `Research output failed validation: ${error.message}.${duplicateNote}`,
      );
    }
    throw error;
  }

  if (classification.category === "security") {
    return decide(
      ticket,
      classification,
      researchResult,
      "security-escalation",
      `Category is "security" — always escalated to human review regardless of confidence.${duplicateNote}`,
    );
  }

  if (classification.confidence < LOW_CONFIDENCE_THRESHOLD) {
    return decide(
      ticket,
      classification,
      researchResult,
      "needs-human-triage",
      `Confidence ${classification.confidence} is below the ${LOW_CONFIDENCE_THRESHOLD} auto-route threshold.${duplicateNote}`,
    );
  }

  return decide(
    ticket,
    classification,
    researchResult,
    "auto-routed",
    `Category "${classification.category}" at confidence ${classification.confidence} met the auto-route bar.${duplicateNote}`,
  );
}
