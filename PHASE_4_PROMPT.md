Read CLAUDE.md at the repo root in full before starting, especially:
- "Non-negotiable architecture decisions" (mcp-atlassian sidecar, NOT Rovo
  MCP; Coordinator is the only JIRA writer; Cosmos DB audit log)
- "Environments and secrets" (`.env.local`, sandbox JIRA project for CI)
- "Decisions made in Phase 2" and "Decisions made in Phase 3" in full —
  Phase 4 sits directly on top of both.
- The "Open items to fill in before Phase 1 starts" checklist — as of
  Phase 3, **"JIRA sandbox project key to use in CI integration tests" is
  still unchecked.** See the Integration tests section below; this blocks
  live verification, not just CI.

Execute Phase 4 ONLY: containerization + real JIRA access via
mcp-atlassian. Do not touch GitHub Actions (Phase 5/6), `apps/dashboard`
(Phase 7), or actual Azure resources (Container Apps, Key Vault, Cosmos
DB — those are deploy-time concerns; this phase is local-only). If you
find yourself writing a `.github/workflows/*.yml` file or provisioning
anything in Azure, stop and flag it instead of continuing.

## What you're building on top of

**`apps/coordinator/src/jira.ts`** currently (both are Phase 3 stubs):

```ts
// TODO(Phase 4): replace with a real mcp-atlassian call that fetches the
// ticket's summary/description/reporter/etc. from JIRA by key.
export async function fetchTicket(ticketKey: string): Promise<Ticket> { ... }

// TODO(Phase 4): replace with real mcp-atlassian calls — comment, label,
// and/or assign based on decision.outcome. Per CLAUDE.md, this must remain
// the only place in the Coordinator that writes to JIRA.
export async function writeBackToJira(ticket: Ticket, decision: TriageDecision): Promise<void> { ... }
```

Both are called from `apps/coordinator/src/index.ts`'s `POST
/webhooks/jira-ticket` route, in that order, with `triageTicket()` (from
`triage.ts`) run in between. Keep that call order and keep
`writeBackToJira` as the only JIRA-writing call site in the repo —
`classifyTicket`/`researchTicket` must not grow write-side logic.

**`Ticket`** (`packages/shared-types/src/ticket.ts`) currently:
```ts
{ key: string, projectKey: string, summary: string, description: string, reporter: string, createdAt: string /* ISO datetime */ }
```
Its inline comment still says "revisit... in Phase 3" — that's stale
(Phase 3 was explicitly told not to touch this and didn't); update the
comment to reflect Phase 4 as the actual resolution point while you're in
there. **Phase 3 was silent on whether this shape is adequate** — it
wasn't confirmed OK, it just wasn't addressed, so treat this as a fully
open question, not a rubber-stamped shape.

Two real call sites depend on `Ticket`'s exact fields and WILL break
silently (not throw — silently produce garbage prompts) if you change
shapes without updating them:
- `apps/classifier/src/index.ts` (`buildUserPrompt`): interpolates
  `` `Reporter: ${ticket.reporter}` ``, `` `Created: ${ticket.createdAt}` ``,
  and calls `ticket.description.trim()` — `description` and `reporter`
  must remain plain strings (or you update this function in lockstep).
- `apps/research/src/index.ts` (`buildUserPrompt`): calls
  `ticket.description.trim()` — same constraint.

**`TriageDecision`** (`packages/shared-types/src/decision.ts`): `{
ticketKey, outcome: "auto-routed" | "needs-human-triage" |
"duplicate-short-circuit" | "security-escalation", classification:
ClassificationResult | null, research: ResearchResult | null, reasoning:
string }`. `writeBackToJira` receives this in full — use `outcome` to
decide what to actually do in JIRA (comment vs. label vs. transition).

**Two things flagged in Phase 2 that land squarely in this phase:**
- Duplicate detection is currently model-reasoning-only (Classifier's
  prompt explicitly tells the model not to invent ticket keys and to
  leave `duplicate_of` null unless the ticket text itself names another
  key). CLAUDE.md's system description says Tier 3 (the JIRA-via-MCP tool
  layer) is something "both subagents call into" directly — which would
  mean giving Classifier/Research their own read-only mcp-atlassian
  access for real similar-ticket search. That's a real scope decision,
  not a formality — see the dedicated bullet below.
- **Note on scope, since this wasn't actually flagged before despite what
  you might expect:** webhook-delivery idempotency (what happens if JIRA
  redelivers the same webhook event) has NOT been raised as a concern in
  any prior phase — not in Phase 3's prompt, not in CLAUDE.md. It's a new
  concern being raised for the first time in this prompt, not a
  previously-flagged item you're now resolving. It matters starting now
  because real JIRA writes mean a redelivered webhook could now produce a
  duplicate comment/label, not just a wasted (idempotent) Anthropic call.
  See the dedicated bullet below for a concrete recommendation.

## Real, verified facts about `sooperset/mcp-atlassian`

Verified via web search/fetch against the project's README and deployment
docs during this prompt-writing session — cite-worthy but the project is
actively developed, so **re-confirm anything load-bearing against the
live README before writing code against it**, especially anything marked
unconfirmed below:

- Docker image: `ghcr.io/sooperset/mcp-atlassian` (confirmed present;
  pin an actual version tag rather than `:latest` for reproducibility —
  check the repo's releases/tags for the current one).
- Transport: set via `TRANSPORT` env var or `--transport` flag —
  `stdio` | `sse` | `streamable-http`. For a sidecar reached over a
  docker-compose network (not the same container/process as Coordinator),
  you need `sse` or `streamable-http`, not `stdio`.
- Port: docs disagree slightly across sources — one deployment guide says
  **default 8000** (`HOST`/`PORT` env vars, `HOST=0.0.0.0` to bind for
  container-to-container traffic), a README usage example shows an
  explicit `--transport sse --port 9000`. **Confirm the actual default
  for whatever version you pin** rather than trusting either number here.
- Auth env vars (Jira Cloud, API-token — per CLAUDE.md's decision, not
  OAuth): `JIRA_URL`, `JIRA_USERNAME`, `JIRA_API_TOKEN`. (Server/Data
  Center would use `JIRA_PERSONAL_TOKEN` instead — not our case per
  CLAUDE.md unless that changes.)
- `ENABLED_TOOLS` env var / `--enabled-tools` flag restricts which of the
  ~98 total tools are exposed — worth using to scope the sidecar down to
  only what Coordinator actually needs (e.g. `jira_get_issue`, whatever
  the comment/label/transition tools turn out to be named — see below).
  `READ_ONLY_MODE` env var also exists, restricting to read-only tools —
  relevant if you decide subagents get their own sidecar access (see the
  duplicate-detection bullet).
- Confirmed tool names: `jira_search` (JQL), `jira_get_issue`,
  `jira_create_issue`, `jira_update_issue`, `jira_transition_issue`.
  **NOT confirmed in this research pass:** the exact tool name(s) for
  adding a comment and for adding/removing labels — don't guess a name
  like `jira_add_comment`; check the live tool list (the server can
  usually enumerate its own tools, or check the docs' full Tools
  Reference) before wiring `writeBackToJira` to a specific tool name.
  **NOT confirmed:** whether `jira_get_issue`'s returned description is
  plain text/markdown or raw Atlassian Document Format (ADF) JSON. This
  directly gates the Ticket-shape question above — if it's ADF, you need
  a conversion step before it can satisfy `description: string` the way
  `classifyTicket`/`researchTicket` already expect (they call
  `.trim()` on it). Verify this against a real sandbox response, not the
  docs, since docs were silent on it.
- A `/healthz` endpoint exists on HTTP transports — useful for a
  docker-compose healthcheck / `depends_on: condition: service_healthy`.
- No official docker-compose example was found in this research pass —
  you're authoring this from the env-var/transport facts above, not
  adapting a template that exists.
- **mcp-atlassian has no webhook-receiving role.** It's purely for
  Coordinator's *outbound* JIRA API calls (fetch, comment, label,
  transition). The actual webhook — JIRA calling Coordinator — is
  unrelated to this sidecar entirely; JIRA's project webhook settings
  would need to point at a publicly reachable Coordinator URL. Getting a
  real cloud JIRA instance to deliver a webhook to a local
  docker-compose'd Coordinator is a tunneling problem (ngrok or similar)
  that's arguably out of scope for "local containerization" — for this
  phase, simulate the webhook delivery with a manual/scripted `curl`
  POST using a real sandbox ticket key, and let mcp-atlassian handle the
  actual JIRA reads/writes that follow. Don't get pulled into solving
  real inbound webhook delivery unless you think it's cheap; if not,
  flag it as deferred rather than silently skipping it.
- **MCP client on the Coordinator side isn't wired up yet at all.**
  Something has to speak the MCP client protocol to the sidecar over
  SSE/streamable-http — this is a new dependency, not something already
  in `apps/coordinator/package.json`. The standard TypeScript client is
  `@modelcontextprotocol/sdk` — confirm current version/API shape before
  depending on specifics, since MCP SDKs move fast. Following this repo's
  existing pattern (Anthropic API calls wrapped in one thin client module,
  `packages/anthropic-client`, per Phase 2), consider a parallel thin
  wrapper — e.g. `apps/coordinator/src/jiraMcpClient.ts` — that owns the
  MCP connection lifecycle (connect once, expose typed tool-call
  methods), with `fetchTicket`/`writeBackToJira` in `jira.ts` becoming the
  business-level callers of it. Your call whether this warrants its own
  workspace package like `anthropic-client` did, or is thin enough to
  live directly in `apps/coordinator/src` — say which and why.

## Scope for this session

1. **Confirm the specifics flagged as unverified above** against the live
   mcp-atlassian README/tool list before writing integration code against
   them: exact comment/label tool names, ADF-vs-plaintext for
   descriptions, and the actual default port for whatever version you
   pin. Don't propagate a guess into working code.

2. **Add an MCP client to `apps/coordinator`** (new dependency +
   thin wrapper, per the design note above) that connects to the
   mcp-atlassian sidecar over the docker-compose network using its
   compose service name as the hostname (e.g. `http://mcp-atlassian:8000`
   or whatever port you confirm) — NOT `localhost`, which only works once
   both processes are colocated in a single Azure Container App
   (a Phase 6 deploy-time concern, not this one).
      - Set `ENABLED_TOOLS` on the mcp-atlassian sidecar to the minimum set
     Coordinator actually calls (confirmed read/write tool names from
     step 1) — do not run it with its full default tool set. This is a
     requirement, not an optional hardening step, since the sidecar's
     credentials will eventually point at production JIRA in a later
     phase; scope it down now so that's already the norm rather than a
     retrofit.
       - The MCP client wrapper should handle a dropped/failed connection
     to the sidecar at runtime (not just at container startup) with
     explicit retry/reconnect logic, mirroring the retry approach already
     used in `packages/anthropic-client`. Document the retry policy
     (attempt count, backoff) in the same place you document the
     client's other design decisions.

3. **Resolve the `Ticket` shape.** Using a real sandbox `jira_get_issue`
   call, decide whether the current shape holds up:
   - If `description` comes back as ADF, add a conversion step (either in
     the new MCP client wrapper or in `fetchTicket`) so `Ticket.description`
     stays a plain string — don't change the type to accommodate ADF
     without updating `classifyTicket`/`researchTicket`'s prompt-building
     code, which currently assumes a plain string.
   - Decide what `reporter` should actually be (JIRA gives you an object
     — accountId, displayName, etc. — not a bare string). If you change
     `Ticket.reporter`'s shape, you MUST update
     `apps/classifier/src/index.ts`'s `buildUserPrompt` (currently
     `` `Reporter: ${ticket.reporter}` ``) in the same change, or its
     prompt silently degrades to something like `Reporter: [object
     Object]` instead of throwing — a much worse failure mode than a
     type error, since nothing would catch it.
   - Update `TicketSchema`/`Ticket` in `packages/shared-types/src/ticket.ts`
     accordingly, fix the stale "Phase 3" comment, and update CLAUDE.md's
     Data contracts section to match (it currently has no `Ticket` entry
     at all, unlike `ClassificationResult`/`ResearchResult`/
     `TriageDecision` — add one while you're there).
   - If you conclude the current shape is actually fine as-is, say so
     explicitly and why, rather than leaving it ambiguous for Phase 5.

4. **Replace the `fetchTicket()` stub** with a real call through your new
   MCP client wrapper. Keep the existing signature
   (`fetchTicket(ticketKey: string): Promise<Ticket>`) unless step 3's
   shape resolution genuinely requires changing it — if so, say why.

5. **Replace the `writeBackToJira()` stub** with real calls based on
   `decision.outcome` — comment with `research.draft_response` when
   available, label/transition as appropriate per outcome (your call on
   the exact mapping, but document it). Reconfirm after this change that
   `writeBackToJira` (and the MCP client wrapper it calls) remains the
   *only* JIRA-write code path in the repo — grep for any other write-
   shaped calls before calling this done.

6. **Dockerfile for `apps/coordinator`.** Multi-stage:
   - Build stage: needs enough of the monorepo to resolve npm workspace
     symlinks and the `tsc -b` project-references graph — not just
     `apps/coordinator` in isolation. Copy root `package.json` +
     `package-lock.json` + `tsconfig.base.json` + `tsconfig.json` +
     every workspace's `package.json`/`tsconfig.json`/`src`, run
     `npm ci`, then build (either root `npm run build`, or a targeted
     `tsc -b apps/coordinator` — either works given the reference graph;
     your call).
   - Runtime stage: ship the built `dist/` output for `shared-types`,
     `anthropic-client`, `classifier`, `research`, and `coordinator` plus
     production-only `node_modules` (`npm ci --omit=dev` or an equivalent
     prune) — not the whole build-stage image. `CMD` should match the
     existing `start` script (`node dist/index.js`) from
     `apps/coordinator/package.json`.
   - Confirm before assuming: are `classifier`/`research`/
     `anthropic-client` still purely in-process workspace dependencies
     post-Phase-3 (they are, as of this writing — `triage.ts` imports
     `classifyTicket`/`researchTicket` directly as functions), or has
     anything changed that would make them separate services needing
     their own Dockerfiles? If still in-process, one Dockerfile
     (Coordinator's) is correct — don't create Dockerfiles for the
     subagent packages.

7. **`docker-compose.yml`** at the repo root, wiring:
   - `coordinator` (built from the new Dockerfile, port mapped for the
     webhook endpoint)
   - `mcp-atlassian` (the pinned image, `TRANSPORT=sse` or
     `streamable-http`, env vars sourced from `.env.local` per CLAUDE.md's
     "Environments and secrets" — gitignored, dev-only JIRA sandbox
     credentials, never production JIRA)
   - Both on a shared compose network; Coordinator reaches the sidecar by
     its compose service name (e.g. `mcp-atlassian`), not `localhost`.
   - Use the `/healthz` endpoint (confirm it exists on whatever transport
     you picked) for a healthcheck/`depends_on` so Coordinator doesn't
     race the sidecar on startup.

8. **Webhook-delivery idempotency — new in this phase, not previously
   flagged.** Concrete recommendation: add a minimal, in-memory (per-
   process) dedup guard in the webhook route or `triageTicket` — key on
   `ticketKey` + a JIRA-provided event timestamp/id if the webhook payload
   carries one, else `ticketKey` + a short TTL window, reject/no-op a
   repeat within that window. Explicitly document that this does NOT
   survive a container restart and does NOT work across multiple replicas
   — durable, cross-restart dedup needs a real store (Cosmos DB per
   CLAUDE.md's audit-log decision, or something else), and that's
   deliberately NOT this phase's job: standing up real Cosmos DB is an
   Azure resource, which this phase's "what NOT to touch" list already
   excludes. **Separately worth flagging back in CLAUDE.md:** the "Build
   phases" list has no phase that explicitly says "wire up Cosmos DB" —
   it's mentioned only as an architecture decision and as what Phase 7's
   optional dashboard reads from. Note this gap explicitly in your
   "Decisions made in Phase 4" writeup rather than quietly deciding which
   phase owns it.

9. **Duplicate-detection scope decision.** CLAUDE.md's system description
   frames Tier 3 (JIRA-via-MCP) as something "both subagents call into,"
   which would mean giving Classifier (and maybe Research) their own
   read-only mcp-atlassian access for real similar-ticket search, instead
   of today's model-reasoning-only `duplicate_of`. Recommendation: treat
   this as out of scope for Phase 4 — it's a second MCP consumer with its
   own auth/network-access questions, on top of everything else this
   phase already covers — and explicitly defer it, rather than silently
   leaving Classifier's prompt as-is without saying you considered the
   alternative. If you disagree and think it's cheap enough to include
   now that the MCP client wrapper exists, make the case explicitly
   rather than just doing it.

10. **Integration tests.** Per CLAUDE.md's CI environment notes, these
    should run against a real local mcp-atlassian pointed at a JIRA
    sandbox/test project, not production JIRA. **Before assuming this is
    fully verifiable: CLAUDE.md's "Open items" checklist still has "JIRA
    sandbox project key to use in CI integration tests" unchecked as of
    Phase 3.** If nobody has provided sandbox credentials/a project key by
    the time you reach this step, don't fake verification — split your
    test coverage into:
    - Unit-level tests with the MCP client mocked (no real network calls)
      — these can and should be fully verified regardless.
    - Live integration tests against a real sandbox — write these, but
      explicitly flag them as unverified/blocked if no sandbox is
      available, rather than reporting `npm run test` as fully green if
      those tests were skipped or never actually ran against real JIRA.

## What NOT to touch

- `.github/workflows` (doesn't exist yet — Phase 5/6).
- `apps/dashboard`.
- Real Azure resources — Container Apps, Key Vault, Cosmos DB. This phase
  is local `docker-compose` only; Azure deployment is Phase 6.
- `apps/classifier`/`apps/research` internals, EXCEPT the specific,
  lockstep `buildUserPrompt` edits required if (and only if) you change
  `Ticket.reporter`'s shape in step 3 — don't touch their prompts or
  retry/validation logic otherwise.

## Verification steps for "done"

- `npm run build` / `npm run typecheck` / `npm run lint` — all pass, same
  as Phase 2/3.
- `npm run test` — existing Phase 2/3 unit tests still pass, plus new
  unit tests for the MCP client wrapper (mocked) and `fetchTicket`/
  `writeBackToJira` (mocked MCP client, not a real sandbox call).
- `docker-compose up` locally brings up both containers; Coordinator's
  `/health` responds; mcp-atlassian's `/healthz` responds.
- If (and only if) a JIRA sandbox project is actually available: hit the
  webhook endpoint with a real sandbox ticket key, confirm a real
  comment/label appears on that sandbox ticket, and confirm this survives
  a redelivery of the same event without double-commenting (per step 8).
  If no sandbox is available, say so explicitly rather than claiming this
  step passed.

## Decisions to fold back into CLAUDE.md's "Decisions made in Phase 4"

- Confirmed mcp-atlassian specifics (tool names for comment/label,
  ADF-vs-plaintext, actual port/version pinned) and where they diverged
  from what this prompt guessed.
- Final `Ticket` shape, and whether `reporter`/`description` changed —
  update the Data contracts section (which currently has no `Ticket`
  entry) accordingly.
- MCP client wrapper location or workspace-package structure, and why.
- The idempotency approach actually implemented, explicitly noting it's
  non-durable, plus the "no phase currently owns Cosmos DB" gap.
- The duplicate-detection scope call (deferred, or done now — and why).
- Whether the JIRA sandbox project existed and integration tests actually
  ran live, or were written but unverified.

Sources consulted for the mcp-atlassian facts above (re-verify against
current docs, don't treat as frozen):
- https://github.com/sooperset/mcp-atlassian
- https://github.com/sooperset/mcp-atlassian/blob/main/README.md
- https://deepwiki.com/sooperset/mcp-atlassian/7.3-deployment-guide
