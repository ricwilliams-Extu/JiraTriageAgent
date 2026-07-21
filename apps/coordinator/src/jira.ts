import pino from "pino";
import { z } from "zod";
import type { Ticket, TriageDecision } from "@jira-triage/shared-types";
import { JiraMcpClient, type JiraMcpClientLike } from "./jiraMcpClient.js";

const logger = pino({ name: "coordinator" });

export class JiraFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JiraFetchError";
  }
}

export class JiraWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JiraWriteError";
  }
}

let sharedClient: JiraMcpClientLike | undefined;
function getSharedClient(): JiraMcpClientLike {
  sharedClient ??= new JiraMcpClient();
  return sharedClient;
}

/**
 * Best-effort shape for mcp-atlassian's `jira_get_issue` response, based on
 * JIRA Cloud's own REST API conventions (which mcp-atlassian wraps) — NOT
 * confirmed against a live response, since no sandbox JIRA project/
 * credentials were available in this session (see CLAUDE.md's "Open items").
 * Smoke-test this against a real sandbox ticket before trusting it; if the
 * live shape differs, this schema (and mapJiraIssueToTicket below) is the
 * only place that needs to change — Ticket itself is unaffected either way.
 */
const JiraIssueResponseSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    description: z.string().nullable().optional(),
    created: z.string(),
    project: z.object({ key: z.string() }),
    reporter: z
      .object({
        displayName: z.string().optional(),
        emailAddress: z.string().optional(),
        accountId: z.string().optional(),
      })
      .nullable()
      .optional(),
    labels: z.array(z.string()).optional(),
  }),
});

function mapJiraIssueToTicket(raw: unknown): Ticket {
  const parsed = JiraIssueResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new JiraFetchError(
      "mcp-atlassian jira_get_issue response did not match the expected shape",
      { cause: parsed.error },
    );
  }

  const { key, fields } = parsed.data;
  const reporter =
    fields.reporter?.displayName ??
    fields.reporter?.emailAddress ??
    fields.reporter?.accountId ??
    "unknown-reporter";

  return {
    key,
    projectKey: fields.project.key,
    summary: fields.summary,
    // mcp-atlassian converts Jira's Atlassian Document Format to
    // markdown/plain text at the tool boundary (confirmed via the project's
    // markdown<->Jira-format conversion fix history) — no ADF handling
    // needed here.
    description: fields.description ?? "",
    reporter,
    // Jira's timestamp format doesn't reliably match strict ISO-8601 (often
    // a non-colon UTC offset like "+0000"), so normalize through Date rather
    // than pass it through raw — keeps TicketSchema's plain `.datetime()`
    // validator (no `{ offset: true }`) unchanged.
    createdAt: new Date(fields.created).toISOString(),
  };
}

export async function fetchTicket(
  ticketKey: string,
  mcpClient: JiraMcpClientLike = getSharedClient(),
): Promise<Ticket> {
  logger.info({ ticketKey }, "fetching ticket from JIRA");

  let raw: string;
  try {
    raw = await mcpClient.callTool("jira_get_issue", { issue_key: ticketKey });
  } catch (error) {
    throw new JiraFetchError(`Failed to fetch ticket ${ticketKey} from JIRA`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new JiraFetchError(`jira_get_issue response for ${ticketKey} was not valid JSON`, {
      cause: error,
    });
  }

  return mapJiraIssueToTicket(parsed);
}

// Outcome-to-label mapping. Prefixed with "triage:" so bot-applied labels
// are visually distinct from human-applied ones on the ticket.
const OUTCOME_LABEL: Record<TriageDecision["outcome"], string> = {
  "auto-routed": "triage:auto-routed",
  "needs-human-triage": "triage:needs-human-triage",
  "duplicate-short-circuit": "triage:duplicate",
  "security-escalation": "triage:security-escalation",
};

function buildCommentBody(decision: TriageDecision): string {
  const lines = [decision.reasoning];
  if (decision.research?.draft_response) {
    lines.push("", "---", decision.research.draft_response);
  }
  return lines.join("\n");
}

/**
 * Fetches the ticket's CURRENT labels immediately before updating them.
 *
 * Not confirmed whether mcp-atlassian's `jira_update_issue` treats
 * `fields.labels` as additive or a full replace — JIRA's underlying REST API
 * normally replaces the whole array on a plain `fields` update (the additive
 * form uses an `update: { labels: [{ add: ... }] }` operations shape
 * instead). Rather than guess which one `jira_update_issue` actually does
 * and risk silently wiping out a real ticket's existing labels, this always
 * re-fetches current labels and sends the merged (deduped) set — correct
 * either way the tool actually behaves.
 */
async function fetchCurrentLabels(
  ticketKey: string,
  mcpClient: JiraMcpClientLike,
): Promise<string[]> {
  const raw = await mcpClient.callTool("jira_get_issue", { issue_key: ticketKey });
  const parsed = JiraIssueResponseSchema.safeParse(JSON.parse(raw));
  return parsed.success ? (parsed.data.fields.labels ?? []) : [];
}

/**
 * Real JIRA write-back via mcp-atlassian. Per CLAUDE.md's hard rule, this
 * (and the JiraMcpClient it calls) must remain the only JIRA-write code path
 * in the repo.
 *
 * Deliberately does NOT attempt a status transition: `jira_transition_issue`
 * needs a transition id/name that's specific to each JIRA project's
 * configured workflow, which isn't knowable without inspecting a live
 * project — hardcoding one would almost certainly fail (or worse, fire the
 * wrong transition) against a real project with a different workflow.
 * Comment + label is a safe, always-valid signal; transitions are left for
 * a later phase once a real target project's workflow can be inspected.
 */
export async function writeBackToJira(
  ticket: Ticket,
  decision: TriageDecision,
  mcpClient: JiraMcpClientLike = getSharedClient(),
): Promise<void> {
  logger.info(
    { ticketKey: ticket.key, outcome: decision.outcome },
    "writing decision back to JIRA",
  );

  try {
    await mcpClient.callTool("jira_add_comment", {
      issue_key: ticket.key,
      body: buildCommentBody(decision),
    });

    const currentLabels = await fetchCurrentLabels(ticket.key, mcpClient);
    const mergedLabels = Array.from(new Set([...currentLabels, OUTCOME_LABEL[decision.outcome]]));
    await mcpClient.callTool("jira_update_issue", {
      issue_key: ticket.key,
      fields: { labels: mergedLabels },
    });
  } catch (error) {
    throw new JiraWriteError(
      `Failed to write triage decision back to JIRA for ticket ${ticket.key}`,
      { cause: error },
    );
  }
}
