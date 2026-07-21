Read CLAUDE.md at the repo root in full before starting, especially:
- "Business rules the Coordinator enforces"
- "Decisions made in Phase 2" (subagent signatures, error types, prompt-
  engineering notes, the TS project-references build fix)
- The `packages/shared-types/src/ticket.ts` inline comment — it explicitly
  flags that the `Ticket` shape is a Phase 1 placeholder to be revisited
  "once real webhook payloads are wired up in Phase 3."

Execute Phase 3 ONLY: Coordinator orchestration. Do not wire real JIRA/
mcp-atlassian access (that's Phase 4 — stub it), do not write Dockerfiles
or docker-compose, do not touch GitHub Actions, and do not touch
`apps/dashboard`. If you find yourself reaching for real JIRA API calls,
a Dockerfile, or a CI YAML file, stop and flag it instead of continuing.

## What you're building on top of

These are the real, current signatures — use them, don't re-derive or
rename them:

- `classifyTicket(ticket: Ticket, client?: AnthropicCompletionClient): Promise<ClassificationResult>`
  — exported from `apps/classifier/src/index.ts`, along with
  `ClassificationValidationError` (thrown on malformed/invalid model
  output; never returns a partial result).
- `researchTicket(ticket: Ticket, classification: ClassificationResult, client?: AnthropicCompletionClient): Promise<ResearchResult>`
  — exported from `apps/research/src/index.ts`, along with
  `ResearchValidationError` (same fail-loud contract).
- `Ticket`, `ClassificationResult`, `ResearchResult` types and their Zod
  schemas (`TicketSchema`, `ClassificationResultSchema`,
  `ResearchResultSchema`) — all exported from `@jira-triage/shared-types`.
  Note the `ticket.ts` placeholder-shape comment above: `Ticket` currently
  has `{ key, projectKey, summary, description, reporter, createdAt }`.
  You do NOT need to redesign this to match a real JIRA webhook envelope
  (that's Phase 4's job once `mcp-atlassian` is actually wired in) — but
  if you find this shape genuinely inadequate for what a webhook handler
  needs, say so explicitly and propose a change rather than silently
  reshaping it.
- `AnthropicClient` / `AnthropicCompletionClient` from
  `@jira-triage/anthropic-client` — you should NOT need to import this
  directly in `apps/coordinator`. It's an implementation detail of
  `classifyTicket`/`researchTicket`; the Coordinator only calls those two
  functions.
- `apps/coordinator/src/index.ts` currently: a bare Express 4 app with one
  route, `GET /health`, listening on `process.env.PORT ?? 3000`. Keep this
  health check working; build the webhook route alongside it, not instead
  of it.
- `apps/coordinator/package.json` scripts: `start` (`node dist/index.js`),
  `dev` (`tsx src/index.ts`), `build`/`typecheck` (`tsc -b`). Current
  dependencies: `@jira-triage/shared-types`, `express`. Dev dependencies:
  `@types/express`, `tsx`, `typescript`.

## Scope for this session

1. **Resolve the project-references gap now, before writing orchestration
   code.** `apps/coordinator/tsconfig.json` currently only has
   `"references": [{ "path": "../../packages/shared-types" }]` — it
   predates Coordinator actually depending on anything else. Phase 3 is
   the point where Coordinator's dependency count jumps from 1 to 3
   (`shared-types`, `classifier`, `research`), so fix this now rather than
   carrying the gap forward:
   - Add `"@jira-triage/classifier": "*"` and `"@jira-triage/research": "*"`
     to `apps/coordinator/package.json` dependencies (same pattern
     `apps/classifier`/`apps/research` already use for
     `@jira-triage/anthropic-client`).
   - Add `{ "path": "../../apps/classifier" }` and
     `{ "path": "../../apps/research" }` to `apps/coordinator/tsconfig.json`'s
     `references` array, alongside the existing `shared-types` entry.
   - You do NOT need to add `packages/anthropic-client` as a reference or
     dependency of `apps/coordinator` — Coordinator never imports it
     directly, and `tsc -b` already builds it transitively as a dependency
     of `classifier`/`research`'s own reference graphs.
   - Verify with the exact repro from Phase 2's fix: delete every `dist/`
     and `*.tsbuildinfo` in the repo, then run
     `npm run typecheck -w apps/coordinator` *alone* — it should
     transitively build `shared-types`, `classifier`, `research`, and
     `anthropic-client` on its own, with no manual pre-build step. If it
     doesn't, the reference graph is wrong — fix it before moving on.

2. **Webhook handler** in `apps/coordinator/src` that receives a JIRA
   ticket event. Since real `mcp-atlassian` access doesn't exist until
   Phase 4, don't try to precisely replicate JIRA's real webhook JSON
   envelope — accept whatever minimal payload identifies the ticket (e.g.
   a ticket key), validate it, and don't over-invest in an exact schema
   here. Keep the boundary between "raw webhook body" and the internal
   `Ticket` domain object explicit (a small adapter/mapping step), even
   though today that adapter is trivial or backed by a stub.

3. **Stubbed ticket fetch.** Add a `fetchTicket(ticketKey: string): Promise<Ticket>`
   (or similar) that returns a mocked/hardcoded `Ticket` for now, with a
   `// TODO(Phase 4):` comment marking exactly where the real
   `mcp-atlassian` call goes. The webhook handler calls this rather than
   assuming the full ticket body arrives in the webhook payload itself.

4. **Orchestration, sequential per CLAUDE.md** ("Research is only called
   *after* Classifier returns... because Research needs the category").
   Recommend structuring this as a pure, HTTP-agnostic function (e.g.
   `triageTicket(ticket: Ticket, deps?: { classify?: typeof classifyTicket; research?: typeof researchTicket })`)
   that the Express route calls — mirrors the existing dependency-
   injection pattern already used for `AnthropicCompletionClient` in
   `apps/classifier`/`apps/research`, and makes the business-rule logic
   testable without spinning up HTTP.
   - Call `classifyTicket(ticket)`.
   - Catch `ClassificationValidationError` — route to a
     "needs-human-triage" outcome, do not crash the handler, do not call
     `researchTicket`.
   - Apply the `duplicate_of` + `confidence >= 0.8` rule *before* deciding
     whether to call Research: per CLAUDE.md this rule explicitly "skips
     Research entirely," so it must short-circuit ahead of the Research
     call, not just ahead of final routing. If `duplicate_of` is set but confidence is BELOW 0.8, do not
     short-circuit — proceed with normal Research + routing as if
     `duplicate_of` weren't set. This low-confidence duplicate signal
     doesn't currently drive any other rule; if you think it should
     surface somewhere (e.g. noted in the decision object's reasoning
     string) rather than being silently dropped, say so and propose it
     rather than deciding unilaterally.
   - Otherwise call `researchTicket(ticket, classification)`. Catch
     `ResearchValidationError` the same way — "needs-human-triage," don't
     crash.
   - Apply the remaining rules to the final routing decision (these
     affect *routing*, not whether Research ran, since CLAUDE.md doesn't
     say to skip Research for them): `category === "security"` always
     escalates regardless of confidence; `confidence < 0.6` routes to
     "needs-human-triage" instead of auto-routing.

5. **Decision object.** Exact shape is your call this session — but it
   must capture at minimum: the routing outcome (e.g. auto-routed vs.
   needs-human-triage vs. duplicate-short-circuit vs. security-escalation
   — pick a concrete set), the full `ClassificationResult`, the full
   `ResearchResult` when Research actually ran (nullable when
   short-circuited or when validation failed before Research), and a
   human-readable reasoning string. Consider whether this belongs in
   `packages/shared-types` as a new schema+type (following the existing
   `ClassificationResult`/`ResearchResult` pattern) since Phase 4's Cosmos
   DB audit log and the optional Phase 7 dashboard will eventually need
   this same shape — your call, but say which way you went and why.
   Whatever you decide, document it in a new "Decisions made in Phase 3"
   section in CLAUDE.md, same pattern as the existing Phase 2 section.

6. **Stub the JIRA write-back.** A function like
   `writeBackToJira(ticket: Ticket, decision: <your decision type>): Promise<void>`
   that logs what it *would* do (comment/label/assignment) and does
   nothing else, with a `// TODO(Phase 4):` marking where the real
   `mcp-atlassian` write-back call goes. Per CLAUDE.md's non-negotiable
   rule, this must be the *only* place anything resembling a JIRA write
   happens — don't let `classifyTicket`/`researchTicket` grow any
   write-side logic.

7. **Tests.** Cover at minimum, with `classifyTicket`/`researchTicket`
   mocked (no real Anthropic calls) — the dependency-injection shape from
   step 4 should make this direct, without needing `vi.mock` module
   hoisting:
   - Duplicate short-circuit path (`duplicate_of` set, confidence >= 0.8)
     — assert Research was never called.
   - Security-escalation path (`category: "security"`, even at high
     confidence).
   - Low-confidence path (`confidence < 0.6`) — routes to
     needs-human-triage.
   - Normal auto-route path (confident, non-duplicate, non-security).
   - `ClassificationValidationError` and `ResearchValidationError` each
     route to needs-human-triage rather than throwing out of the handler.
   Colocate as `*.test.ts` per CLAUDE.md's existing convention; root
   `npm run test` (Vitest) will pick them up automatically via the
   existing `vitest.config.ts` globs — no new config needed unless you add
   HTTP-level route tests, in which case note that `supertest` (or
   similar) isn't a dependency anywhere in this repo yet and you'd be
   introducing it; that's fine, but call it out as a new dependency
   decision rather than adding it silently.

## What NOT to touch

- `packages/anthropic-client`, `apps/classifier`, `apps/research` internals
  — Phase 3 only consumes their exported functions/types, it doesn't
  change their prompts, retry logic, or validation.
- `apps/dashboard`.
- Docker / `docker-compose.yml` (doesn't exist yet — Phase 4).
- `mcp-atlassian` / any real JIRA API or MCP client code.
- `.github/workflows` (doesn't exist yet — Phase 5/6).

## Verification steps for "done"

These are the repo's real scripts, confirmed working as of Phase 2 — use
them as-is:

- `npm run test` — all existing Classifier/Research tests plus your new
  Coordinator tests pass.
- `npm run typecheck` — passes at the root, AND (per step 1 above)
  `npm run typecheck -w apps/coordinator` passes in isolation on a tree
  with no `dist/` or `*.tsbuildinfo` anywhere.
- `npm run lint` — passes.
- Show at least one example each of: the duplicate short-circuit skipping
  Research, and a validation error being caught and routed to
  needs-human-triage rather than propagating as an unhandled rejection.

List any decisions you made that aren't already dictated above (decision
object shape and where it lives, webhook payload validation approach,
whether you added `supertest` or kept tests HTTP-free, exact
needs-human-triage/outcome enum values) so they can be folded back into
CLAUDE.md's "Decisions made in Phase 3" section.
