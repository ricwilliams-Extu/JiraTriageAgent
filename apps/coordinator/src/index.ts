import express from "express";
import pino from "pino";
import { z } from "zod";
import { buildDedupeKey, isDuplicateDelivery } from "./idempotency.js";
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
// `eventId` is optional since real JIRA webhook envelopes aren't modeled yet
// either; when present it drives exact dedup, otherwise idempotency.ts falls
// back to a ticketKey + TTL window (see its own doc comment for the tradeoff).
const TicketEventSchema = z.object({
  ticketKey: z.string(),
  eventId: z.string().optional(),
});

app.post("/webhooks/jira-ticket", async (req, res) => {
  const parsed = TicketEventSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues }, "rejected malformed webhook payload");
    res.status(400).json({ error: "invalid webhook payload", issues: parsed.error.issues });
    return;
  }

  const { ticketKey, eventId } = parsed.data;
  logger.info({ ticketKey, eventId }, "received ticket event");

  const dedupeKey = buildDedupeKey(ticketKey, eventId);
  if (isDuplicateDelivery(dedupeKey)) {
    logger.warn({ ticketKey, eventId }, "duplicate webhook delivery, skipping");
    res.status(200).json({ ticketKey, skipped: true, reason: "duplicate delivery" });
    return;
  }

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
