import express from "express";
import pino from "pino";
import { z } from "zod";
import { fetchTicket, writeBackToJira } from "./jira.js";
import { triageTicket } from "./triage.js";

const logger = pino({ name: "coordinator" });

const app = express();
app.use(express.json());
const port = process.env.PORT ?? 3000;

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Deliberately minimal — not a replica of JIRA's real webhook JSON envelope.
// Phase 4 maps the real mcp-atlassian-sourced event onto this once JIRA
// access exists; for now the payload only needs to identify which ticket to
// triage.
const TicketEventSchema = z.object({
  ticketKey: z.string(),
});

app.post("/webhooks/jira-ticket", async (req, res) => {
  const parsed = TicketEventSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues }, "rejected malformed webhook payload");
    res.status(400).json({ error: "invalid webhook payload", issues: parsed.error.issues });
    return;
  }

  const { ticketKey } = parsed.data;
  logger.info({ ticketKey }, "received ticket event");

  try {
    const ticket = await fetchTicket(ticketKey);
    const decision = await triageTicket(ticket);
    await writeBackToJira(ticket, decision);
    logger.info({ ticketKey, outcome: decision.outcome }, "ticket triaged");
    res.status(200).json(decision);
  } catch (error) {
    logger.error({ ticketKey, err: error }, "unexpected error triaging ticket");
    res.status(500).json({ error: "internal error triaging ticket" });
  }
});

app.listen(port, () => {
  logger.info({ port }, "coordinator listening");
});
