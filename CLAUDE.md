# JIRA Triage Agent — Project Brief

This file is the persistent context for Claude Code across all sessions on this repo.
Read this before starting any work. Keep it updated as decisions change.

## What this system does

A 3-tier agent system that triages incoming JIRA tickets automatically:

1. **Coordinator** (Tier 1) — receives JIRA webhook events, orchestrates the two
   subagents below, applies business rules, and is the *only* component that
   writes back to JIRA.
2. **Classifier subagent** (Tier 2) — turns raw ticket text into structured
   metadata: category, component, severity, confidence, duplicate detection.
3. **Research subagent** (Tier 2) — given the Classifier's output, gathers
   supporting context: similar resolved tickets, relevant docs/runbooks,
   suggested owning team, a draft response.

Tier 3 is not an agent — it's the tool layer (JIRA API via MCP, docs search)
that both subagents call into.

## Non-negotiable architecture decisions (don't relitigate these)

- **Language: TypeScript**, npm workspaces monorepo. No Python components.
- **JIRA access: via `sooperset/mcp-atlassian`** (community MCP server,
  API-token auth), run as a **sidecar container** alongside the Coordinator
  in Azure Container Apps. We are explicitly NOT using Atlassian's official
  Rovo MCP Server, because its OAuth 2.1 flow requires interactive human
  consent and this service runs unattended on a webhook trigger.
  **Local dev runs it as a sibling OS process instead of a container**
  (`uvx mcp-atlassian`, not Docker — see "Decisions made in Phase 4" for
  why), but reaches it the same way production does: over `localhost`.
  Container Apps sidecars share a network namespace and are also reached
  over `localhost`, so there is no environment-specific hostname branch
  between local dev and production — `MCP_ATLASSIAN_URL` defaults to
  `http://localhost:8000/mcp` everywhere.
- **Hosting: Azure Container Apps**, not Azure Functions. The Agent SDK's
  loop and subagent model want a long-lived Node process, not a stateless
  function invocation.
- **CI/CD: GitHub Actions**, deploying to Azure via **OIDC federation**
  (`azure/login` with federated credentials). Do NOT use a long-lived
  Azure service principal secret stored in GitHub Secrets — set up
  workload identity federation instead.
- **Secrets: Azure Key Vault**, referenced via the Container App's managed
  identity. Never hardcode API keys or commit `.env` files with real values.
- **Audit log: Azure Cosmos DB.** Every ticket processed gets a document:
  ticket key, Classifier output, Research output, final Coordinator
  decision, timestamp.
- **Coordinator writes to JIRA — subagents never do.** This is a hard rule,
  not a style preference. Keeps a single point of accountability for what
  changed on a ticket and why.

## Repo layout

```
/apps
  /coordinator      Main service: webhook handler + idempotency guard
                    (index.ts, idempotency.ts), orchestration + business
                    rules (triage.ts), real JIRA access via mcp-atlassian
                    (jira.ts, jiraMcpClient.ts — see "Decisions made in
                    Phase 4"). Dockerfile builds this from the repo root.
  /classifier        Subagent module (called by Coordinator, in-process — not
                      an Agent SDK Task; see "Decisions made in Phase 2")
  /research           Subagent module (same)
  /dashboard          OPTIONAL React + Vite app, read-only view over the audit log
/packages
  /shared-types       Zod schemas for Ticket, ClassificationResult,
                      ResearchResult, TriageDecision
  /anthropic-client   Generic Anthropic Messages API wrapper (system+prompt in,
                      raw text out) with retry/backoff. No Classifier/Research-
                      specific logic lives here.
/.github/workflows
  ci.yml              Runs on every PR: install, lint, typecheck, unit test, build
  deploy.yml          Runs on merge to main: build/push images, deploy to Azure
package.json (root)   `dev` script runs Coordinator + mcp-atlassian as sibling
                      local processes (`concurrently` + `dotenv-cli`, not
                      docker-compose — this dev VM has no Docker; see
                      "Decisions made in Phase 4")
.dockerignore         Keeps node_modules/dist/.git out of the build context
.env.local.example    Template for `.env.local` (gitignored) — copy, fill in
                      sandbox JIRA + Anthropic credentials
tsconfig.base.json    Shared compilerOptions, extended by every package/app
tsconfig.json         Root TS project-references "solution" file (files: [],
                      references: [...]) — lets `tsc -b` build/typecheck the
                      whole graph in one command, in dependency order
```

## Data contracts (do not change shapes without updating shared-types first)

**Ticket** (Coordinator's internal domain shape, fed to both subagents —
evaluated against real mcp-atlassian output in Phase 4 and kept unchanged;
see "Decisions made in Phase 4" for why):
```ts
{
  key: string,
  projectKey: string,
  summary: string,
  description: string,        // markdown/plain text — mcp-atlassian converts
                               // JIRA's Atlassian Document Format for you
  reporter: string,            // flattened display name, resolved in
                                // apps/coordinator/src/jira.ts's mapping layer
  createdAt: string            // ISO-8601 UTC ("Z"), normalized in that same
                                // mapping layer from JIRA's raw timestamp
}
```

**ClassificationResult** (Classifier subagent output):
```ts
{
  category: "bug" | "feature-request" | "question" | "infra" | "security",
  component: string,
  severity: "critical" | "high" | "medium" | "low",
  confidence: number,       // 0.0 - 1.0
  duplicate_of: string | null,  // JIRA ticket key, if a likely duplicate
  reasoning: string
}
```

**ResearchResult** (Research subagent output):
```ts
{
  similar_resolved_tickets: string[],   // JIRA ticket keys
  relevant_docs: string[],              // doc/runbook titles or paths
  suggested_owner_team: string,
  draft_response: string,
  escalation_flag: boolean
}
```

Both are validated with Zod at the boundary where the Coordinator receives
them. Malformed subagent output should fail loudly (throw / log / route to
human review), never silently pass through.

**TriageDecision** (Coordinator's final output, added in Phase 3 — lives in
`shared-types` alongside the other two since Phase 4's Cosmos DB audit log
and the optional Phase 7 dashboard both need this same shape):
```ts
{
  ticketKey: string,
  outcome: "auto-routed" | "needs-human-triage" | "duplicate-short-circuit" | "security-escalation",
  classification: ClassificationResult | null,  // null only if Classifier validation failed
  research: ResearchResult | null,              // null if short-circuited, or if Research validation failed
  reasoning: string
}
```

## Business rules the Coordinator enforces (on top of subagent output)

- If `category === "security"`, always escalate to human review regardless
  of confidence.
- If `confidence < 0.6`, route to the "needs-human-triage" queue/label
  instead of auto-routing.
- If `duplicate_of` is set with confidence >= 0.8, short-circuit: comment,
  link, skip Research entirely.
- Research is only called *after* Classifier returns — sequential, not
  parallel, because Research needs the category to know what to search for.

## Coding conventions

- Node LTS version: **20.x** (already reflected in root `package.json`
  `engines.node: ">=20.0.0"`)
- Package manager: npm (workspaces), not yarn/pnpm
- Linting: ESLint + Prettier, config at repo root, shared across all apps
- Testing: **Vitest**, unit tests colocated with source (`*.test.ts`),
  integration tests in a top-level `/tests` dir (not created yet — Phase
  2 only needed subagent unit tests). Root `npm run test` runs `vitest run`
  once across the whole repo (a root `vitest.config.ts` globs
  `apps/*/src/**/*.test.ts` and `packages/*/src/**/*.test.ts`, so there's no
  per-workspace test script to maintain).
- All Anthropic API calls are wrapped in `packages/anthropic-client`
  (not scattered `fetch` calls) so retry/error handling lives in one place.
  See "Decisions made in Phase 2" below for why this is a raw
  `@anthropic-ai/sdk` wrapper rather than the Agent SDK.
- Structured logging (not `console.log`) — **pino** — every log line for a
  ticket should include the ticket key for traceability. Currently used in
  `apps/classifier` and `apps/research`; `packages/anthropic-client` stays
  generic and does not log ticket context.

## Environments and secrets

- **Local dev:** `.env.local` (gitignored) with dev-only keys — copy
  `.env.local.example` (committed template) and fill in real sandbox
  values. Root `npm run dev` starts Coordinator and mcp-atlassian together
  as sibling local processes (`concurrently` + `dotenv-cli`, mcp-atlassian
  via `uvx`) — not docker-compose, since this dev VM has no Docker
  installed; see "Decisions made in Phase 4".
- **CI:** no real secrets. `.github/workflows/ci.yml` (Phase 5) runs
  entirely against the existing mocked Anthropic-client/`JiraMcpClient`
  test doubles — there is no live mcp-atlassian instance and no JIRA
  sandbox wired into CI, despite what this bullet used to say. Live-sandbox
  integration testing is still blocked on the unchecked "JIRA sandbox
  project key" open item below, and per Phase 5's explicit scope, real
  credentials are deliberately kept out of the PR-triggered workflow
  regardless — see "Decisions made in Phase 5."
- **Production:** Azure Key Vault + managed identity. No secrets in
  GitHub Actions beyond what's needed for the OIDC federation itself.

## Build phases (see full plan in project notes — work one phase at a time)

| Phase | What it covers | Status |
|---|---|---|
| 0 | This file | Complete |
| 1 | Repo scaffolding (empty apps, health checks, workspaces wired up) | Complete |
| 2 | Shared types + subagent logic (unit tested against schemas) | Complete |
| 3 | Coordinator orchestration (full loop, local mcp-atlassian, no prod JIRA) | Complete |
| 4 | Containerization (Dockerfile; local dev uses sibling processes, not docker-compose — this dev VM has no Docker, see "Decisions made in Phase 4") | Complete |
| 5 | GitHub Actions CI (lint/test/typecheck + Docker build check on PR) | Written, unverified — `.github/workflows/ci.yml` exists but has never run on a real PR (see "Decisions made in Phase 5"); flip to Complete once both jobs go green there |
| 6 | GitHub Actions CD (deploy to Azure Container Apps via OIDC) | Not started — unblocked to consume the Phase 5-validated Dockerfile once Phase 5 is confirmed green |
| 7 | OPTIONAL: React dashboard over the Cosmos DB audit log | Not started |

**Do not skip ahead to a later phase's concerns while working on an earlier
one.** E.g. don't wire real Azure deploys while still building Phase 2's
subagent logic. Flag if you think a phase boundary should move, rather than
quietly expanding scope.

## Open items to fill in before Phase 1 starts

- [x] Node LTS version to pin — 20.x
- [x] Test framework choice — Vitest
- [x] Logging library choice — pino
- [ ] Azure subscription / resource group names for the target environment
- [ ] JIRA sandbox project key to use in CI integration tests

## Decisions made in Phase 2

Phase 2 implemented real Classifier/Research subagent logic on top of the
Phase 1 scaffolding. Nothing in "Non-negotiable architecture decisions"
changed; these are the choices made to fill in that phase's open items,
plus implementation notes worth knowing before Phase 3 builds on top.

- **Anthropic client lives in `packages/anthropic-client`**, not inside
  `shared-types`. It has no dependency on Zod/Ticket/ClassificationResult —
  it only knows `{ system, prompt, model?, maxTokens? } → string` — so it
  can be a dependency of `shared-types`-consuming apps without a circular
  or backwards dependency.
- **Raw `@anthropic-ai/sdk` (Messages API), not the Agent SDK.** The
  Classifier and Research subagents are single-turn "system prompt in,
  JSON out" calls with no tool use, no multi-turn loop, and no need for
  the Agent SDK's subprocess/session model. The Agent SDK is the right
  fit for the Coordinator's orchestration loop (Phase 3) if it ends up
  spawning subagents as actual Agent SDK tasks — that's a Phase 3 decision,
  not foreclosed by this one.
- **Retry strategy:** the client disables the SDK's own built-in retry
  (`maxRetries: 0` on the `Anthropic` client) and instead retries itself,
  explicitly, so behavior is observable/testable rather than hidden inside
  the SDK. Retries on `RateLimitError`/`5xx` (via `APIError.status`) and
  `APIConnectionError`, up to 3 attempts, exponential backoff starting at
  500ms (500ms, 1000ms, 2000ms). Non-retryable errors (4xx other than 429,
  malformed-response errors) throw immediately.
- **Fail-loud validation errors:** `ClassificationValidationError` and
  `ResearchValidationError` (one per subagent, defined alongside each
  subagent's code, not in shared-types) are thrown — with the parse/Zod
  error as `.cause` and the raw model text logged — for both "not valid
  JSON" and "valid JSON but fails the schema" cases. Neither subagent ever
  returns a best-effort/partial result.
- **Prompt engineering — worth reviewing before Phase 3:**
  - Both system prompts explicitly forbid markdown code fences/preamble,
    but the parsing code defensively strips a wrapping ` ```json ... ``` `
    fence if the model adds one anyway before attempting `JSON.parse` —
    this is normalizing a common LLM formatting quirk, not tolerating bad
    data; anything that still doesn't parse/validate after that still
    throws.
  - `duplicate_of` (Classifier) and `similar_resolved_tickets` /
    `relevant_docs` (Research): since neither subagent has real search in
    Phase 2, prompts explicitly tell the model to leave these null/empty
    unless the *ticket text itself* names another ticket, and explicitly
    forbid inventing plausible-looking ticket keys or doc titles. Worth
    re-checking once Phase 3 wires real JIRA/docs search — the prompt
    should change to prefer the tool result over the model's own guess.
  - Research's `escalation_flag` guidance nudges the model toward `true`
    for `category: security` or `severity: critical`, which overlaps with
    the Coordinator's own business rules (security always escalates,
    confidence < 0.6 routes to human). This is intentional redundancy, not
    a conflict — the Coordinator's rules are still the enforcement point;
    the subagent's flag is advisory context for the human/Coordinator.
- **Build-order gotcha — found during Phase 2, fixed via TS project
  references before Phase 2 closed out.** Each package's `types` field
  points at `./dist/index.d.ts`, so a workspace that depends on another
  workspace package (e.g. `classifier` → `anthropic-client`) used to fail
  with "Cannot find module" on a clean checkout until the dependency's
  `dist/` had been built at least once. Fixed by adding
  `"composite": true` + a `references` array to every non-dashboard
  package's `tsconfig.json`, plus a root solution-style `tsconfig.json`
  (see Repo layout). Every package's `build`/`typecheck` script is now
  `tsc -b` instead of `tsc -p [--noEmit]` — `tsc -b` walks the reference
  graph and transitively builds any stale/missing dependency before
  checking the requested project, so `npm run typecheck -w apps/classifier`
  run alone, on a tree with no `dist/` anywhere, now succeeds on its own
  (verified). `apps/dashboard` is deliberately excluded from the reference
  graph — it's a Vite/`noEmit`-mode project with no workspace dependencies,
  and `noEmit` is incompatible with `composite`. Its own
  `build`/`typecheck` scripts are unchanged (`tsc -p tsconfig.json --noEmit`
  + `vite build`), and the root scripts call it as a separate step after
  `tsc -b`. One side effect worth knowing: `tsc -b` has no no-emit mode, so
  `typecheck` now emits to `dist/` same as `build` does — harmless since
  `dist/` (and the new `*.tsbuildinfo` incremental-cache files, also now
  gitignored) were never committed, but "typecheck" and "build" are
  mechanically the same command now; the second one is just a fast
  incremental no-op.

## Decisions made in Phase 3

Phase 3 implemented Coordinator orchestration: a webhook route, sequential
Classifier→Research calling with the business rules from CLAUDE.md applied,
a stubbed ticket fetch, and a stubbed JIRA write-back. Real `mcp-atlassian`
access, Docker, and CI are still untouched (Phase 4+).

- **Project-references gap closed before writing orchestration code**, per
  the Phase 2 flag. `apps/coordinator/tsconfig.json` now references
  `packages/shared-types`, `apps/classifier`, and `apps/research` (not
  `packages/anthropic-client` directly — it's transitively built as a
  dependency of `classifier`/`research`'s own graphs). Verified with the
  same clean-tree repro as Phase 2:
  `npm run typecheck -w apps/coordinator` alone, on a tree with every
  `dist/` and `*.tsbuildinfo` deleted, transitively builds all four
  dependencies and passes with no manual pre-build step.
- **`triageTicket(ticket, deps?)` in `apps/coordinator/src/triage.ts`** is
  the pure orchestration function — HTTP-agnostic, takes an optional
  `{ classify?, research? }` dependency-injection object defaulting to the
  real `classifyTicket`/`researchTicket`, mirroring the DI pattern already
  used for `AnthropicCompletionClient` in Phase 2. This is what's unit
  tested (`apps/coordinator/src/triage.test.ts`, 8 cases); the Express
  route in `index.ts` is a thin wrapper with no business logic of its own,
  so no HTTP-level test tooling (e.g. `supertest`) was added — call this
  out if a future phase wants route-level tests, since it'd be a new
  dependency decision.
- **Rule precedence, resolved exactly as flagged in `PHASE_3_PROMPT.md`:**
  classify → if `duplicate_of` set AND confidence >= 0.8, short-circuit
  immediately (`"duplicate-short-circuit"`, Research never called) — this
  takes priority over everything else, including a `security` category,
  because CLAUDE.md's rule for it has no category exception and explicitly
  requires it ahead of the Research call. Otherwise, Research always runs
  (even for `security` or low-confidence tickets, since CLAUDE.md doesn't
  say to skip Research for those — a human reviewer still benefits from
  Research's context), and only then do `category === "security"` (→
  `"security-escalation"`) and `confidence < 0.6` (→ `"needs-human-triage"`)
  decide final routing, else `"auto-routed"`.
- **Low-confidence duplicate signal is preserved, not dropped.** If
  `duplicate_of` is set but confidence is below 0.8, the short-circuit
  doesn't fire — full triage proceeds — but the duplicate hint is appended
  to the decision's `reasoning` string so it isn't silently lost.
- **`TriageDecision` lives in `packages/shared-types`** (new
  `decision.ts`), not in `apps/coordinator`, following the existing
  `ClassificationResult`/`ResearchResult` pattern — see Data contracts
  above for the shape and the exact 4-value `outcome` enum.
- **Only `ClassificationValidationError`/`ResearchValidationError` are
  caught inside `triageTicket`**; any other error (e.g. a network failure
  from either subagent) is deliberately rethrown rather than reframed as
  `"needs-human-triage"` — a transient system failure is not the same kind
  of problem as bad model output, and collapsing them would hide real
  outages behind a routing label. The Express route's try/catch is the
  backstop for that case (logs and returns HTTP 500).
- **Webhook payload is intentionally minimal**: `{ ticketKey: string }`,
  validated with a local Zod schema in `index.ts` — not an attempt to
  replicate JIRA's real webhook envelope, per the Phase 3 prompt's
  guidance that real payload mapping is Phase 4's concern once
  `mcp-atlassian` exists. `fetchTicket(ticketKey)` in `jira.ts` is the
  stub that turns a key into a full (mocked) `Ticket`; `writeBackToJira`
  is the stub for the write side. Both carry `// TODO(Phase 4):` markers
  at the exact call site the real `mcp-atlassian` integration replaces.
- **`vitest.config.ts` aliases extended** to `@jira-triage/classifier` and
  `@jira-triage/research` (alongside the existing `shared-types`/
  `anthropic-client` aliases), so Coordinator's tests also run against
  current source rather than requiring a prebuilt `dist/` — consistent
  with the reasoning behind the original two aliases in Phase 2.

## Decisions made in Phase 4

Phase 4 replaced the `fetchTicket`/`writeBackToJira` stubs with real
mcp-atlassian calls, added containerization (Dockerfile only — see the
Docker-availability pivot below), and resolved the `Ticket`-shape and
webhook-idempotency questions flagged for this phase. **Important caveat
up front: no JIRA sandbox project or credentials were available in this
session** (CLAUDE.md's "Open items" checklist still has this unchecked
below) — so nothing here has been verified end-to-end against a real
sandbox ticket. This gap is called out explicitly at each relevant point
below rather than glossed over; treat anything marked unverified as the
first thing to smoke-test once a sandbox is available.

- **Pivot: local dev runs Coordinator and mcp-atlassian as sibling
  processes, not docker-compose — this dev VM has no Docker installed at
  all** (discovered mid-Phase-4, not merely "unverified" like the sandbox
  gap; the `docker` CLI itself doesn't exist in this environment).
  `docker-compose.yml` was removed. In its place: mcp-atlassian runs
  directly via `uvx mcp-atlassian --transport streamable-http --port 8000
  --enabled-tools jira_get_issue,jira_add_comment,jira_update_issue`
  (`uvx` — or `pipx run` — needs to be installed on the dev machine; it is
  not an npm dependency), and Coordinator runs via its existing
  `npm run dev`. Root `npm run dev` (new `concurrently` + `dotenv-cli`
  devDependencies) starts both together: `dotenv-cli` loads `.env.local`
  (for `JIRA_URL`/`JIRA_USERNAME`/`JIRA_API_TOKEN`/`ANTHROPIC_API_KEY`)
  into the environment of both child processes, and `concurrently` runs
  them side by side with labeled, colored output. Chose plain
  `concurrently` in a root npm script over a Procfile-runner (e.g.
  `foreman`/`nf`) since it's one more script in the existing
  `package.json`, not a new process-manager convention, and it's
  cross-platform (works the same under PowerShell and bash).
  `ENABLED_TOOLS` is passed as a CLI flag baked into the committed
  `dev:mcp-atlassian` script (not left to `.env.local`'s discretion) so
  the tool-scoping requirement below can't be silently dropped by a local
  env file.
  - **The `localhost` addressing this forced is actually an improvement,
    not just a workaround.** The original design modeled `localhost` vs.
    a compose-network hostname as an environment-specific branch —
    `http://mcp-atlassian:8000/mcp` locally under compose,
    `http://localhost:8000/mcp` only once deployed to a shared Azure
    Container App. That branch no longer exists: `JiraMcpClient`'s
    `DEFAULT_URL` and `.env.local.example` both now default to
    `http://localhost:8000/mcp` unconditionally, because sibling local
    processes and co-located Container App sidecars are both reached over
    `localhost`. One code path, one default, verified in both places it
    will actually run — compose was the odd one out, not the norm.
  - **No compose-style `depends_on: condition: service_healthy` startup
    ordering exists anymore**, and nothing replaces it — `concurrently`
    starts both processes at once with no readiness gate between them.
    This is an accepted gap, not an oversight: `JiraMcpClient.callTool`
    already retries with backoff (see below), which absorbs a Coordinator
    request arriving before mcp-atlassian has finished starting up, so
    the missing startup gate doesn't need a dedicated fix.
  - **`apps/coordinator/Dockerfile` is still written**, for Phase 6's
    Azure deploy — but it was not, and could not be, build- or run-tested
    locally in this session (no `docker` CLI at all, not just "wasn't
    tried"). Its header comment now says so explicitly: validation is
    deferred to GitHub Actions CI (Phase 5) or `az acr build` (Phase 6),
    not a developer's local `docker build`. Don't treat this Dockerfile as
    more trustworthy than the sandbox-blocked integration tests below —
    both are "written, unverified."

- **`Ticket`'s shape is unchanged.** Concluded it's fine as-is (see Data
  contracts above) — the adaptation between JIRA's real representation and
  this internal domain type happens entirely in
  `apps/coordinator/src/jira.ts`'s mapping layer, not in the type itself:
  - `description`: mcp-atlassian converts JIRA's Atlassian Document Format
    to markdown/plain text at the tool boundary (confirmed via that
    project's own markdown↔Jira-format conversion fix history, not by a
    live response) — no ADF handling needed on our side.
  - `reporter`: JIRA's real reporter is an object (`displayName`,
    `emailAddress`, `accountId`), not a bare string. Rather than change
    `Ticket.reporter`'s type (which would force an update to
    `apps/classifier`'s `buildUserPrompt`, currently
    `` `Reporter: ${ticket.reporter}` ``), the mapping layer flattens it to
    the first available of `displayName` → `emailAddress` → `accountId` →
    `"unknown-reporter"`. Classifier/Research are untouched.
  - `createdAt`: JIRA's timestamp format doesn't reliably match strict
    ISO-8601 (commonly a non-colon UTC offset like `+0000`). Normalized via
    `new Date(fields.created).toISOString()` in the mapping layer, so
    `TicketSchema`'s plain `.datetime()` validator (no `{ offset: true }`)
    didn't need to change either.
  - The stale "revisit in Phase 3" comment on `ticket.ts` is fixed to
    reflect this Phase 4 resolution.
- **mcp-atlassian facts confirmed by web research this session** (cited in
  `PHASE_4_PROMPT.md`), **none verified against a live instance**:
  Docker image `ghcr.io/sooperset/mcp-atlassian`; `jira_get_issue`,
  `jira_add_comment` (takes a `body` param, accepts Markdown),
  `jira_update_issue`, `jira_transition_issue`, `jira_search`,
  `jira_create_issue` as real tool names; `TRANSPORT`/`PORT`/`HOST`/
  `ENABLED_TOOLS`/`READ_ONLY_MODE` env vars. **Still not confirmed:** the
  exact JSON shape `jira_get_issue` actually returns (the
  `JiraIssueResponseSchema` in `jira.ts` is a best-effort guess based on
  JIRA's own REST API conventions, explicitly commented as such — smoke
  test against a real sandbox response before trusting it), and whether
  there's a dedicated label-only tool (none was found; `writeBackToJira`
  uses `jira_update_issue`'s `fields.labels` for this, see below).
- **Chose `StreamableHTTPClientTransport` over `SSEClientTransport`** from
  `@modelcontextprotocol/sdk` (v1.29.0) — the SDK's own docs mark
  `SSEClientTransport` deprecated in favor of it, and it has built-in
  `reconnectionOptions` (max delay, initial delay, backoff factor, max
  retries), which directly satisfies the runtime-reconnect requirement
  without hand-rolling stream-level reconnect logic.
- **`apps/coordinator/src/jiraMcpClient.ts`** is the thin MCP-connection
  wrapper (mirrors `packages/anthropic-client`'s role, but stays inside
  `apps/coordinator` rather than becoming its own workspace package — it
  has no reuse case outside the Coordinator, unlike the Anthropic client
  which both subagents share). Two resilience layers, deliberately not
  one: the transport's own `reconnectionOptions` handle the underlying
  stream dropping; `callTool()` additionally retries explicitly on top
  (discarding and re-establishing the cached connection on failure),
  since a single failed request isn't the same problem as a dropped
  stream. `JiraMcpClientLike` is the DI seam `jira.ts` depends on, mirror
  of `AnthropicCompletionClient`. Known limitation, documented in code:
  not concurrency-hardened for two simultaneous first connections.
- **`ENABLED_TOOLS` scoped down on the sidecar** to exactly
  `jira_get_issue,jira_add_comment,jira_update_issue` — the three tools
  Coordinator actually calls — rather than the server's full ~98-tool
  default, per the approved prompt's requirement (this same sidecar
  config pattern will eventually point at production JIRA credentials, so
  the minimal-scope habit starts now).
- **Label updates re-fetch current labels and merge, rather than trusting
  `jira_update_issue`'s `fields.labels` to be additive.** Real risk found
  while writing this, not in the original prompt: JIRA's REST API
  normally *replaces* the whole labels array on a plain `fields` update
  (the additive form is a separate `update: { labels: [{ add: ... }] }`
  operations shape) — sending just the triage label without checking
  first could have silently wiped out a real ticket's existing labels.
  `writeBackToJira` re-fetches labels immediately before updating and
  sends the deduped union, which is correct regardless of which behavior
  `jira_update_issue` actually has.
- **No status transition is attempted.** `jira_transition_issue` needs a
  transition id/name specific to each JIRA project's configured workflow,
  which isn't knowable without inspecting a live project — hardcoding one
  would likely fail, or worse, fire the wrong transition. Comment + a
  `triage:<outcome>` label (e.g. `triage:security-escalation`) is the
  outcome signal for this phase; transitions are left for whenever a real
  target project's workflow can actually be inspected.
- **Webhook-delivery idempotency**: added `apps/coordinator/src/idempotency.ts`,
  an in-memory `Map`-based dedup guard keyed on the webhook payload's
  optional `eventId` (new, optional field on the webhook schema), falling
  back to `ticketKey` alone within a 2-minute TTL window when absent.
  Explicitly non-durable — does not survive a restart, does not work
  across replicas — and durable cross-restart dedup needs a real store
  (Cosmos DB, per the audit-log architecture decision) which is
  deliberately out of scope here (standing up real Cosmos DB is an Azure
  resource, excluded from this local-containerization phase). **Separately
  worth flagging: CLAUDE.md's "Build phases" list has no phase that
  explicitly says "wire up Cosmos DB"** — it's only mentioned as an
  architecture decision and as what the optional Phase 7 dashboard reads
  from. This gap still exists; whoever picks up durable audit-logging/
  idempotency should either fold it into an existing phase or add a new
  one, rather than assume it's covered.
- **Duplicate-detection scope: deferred, not done.** CLAUDE.md's system
  description frames Tier 3 (JIRA-via-MCP) as something "both subagents
  call into," which would mean giving Classifier (and maybe Research)
  their own read-only mcp-atlassian access for real similar-ticket search
  instead of today's model-reasoning-only `duplicate_of`. Judged this as
  a second MCP consumer with its own auth/network-access questions, on
  top of everything else in this phase, and out of scope for now.
  Classifier/Research prompts are unchanged from Phase 2.
- **`apps/coordinator/Dockerfile` could not be verified in this
  session** — no Docker installed in the environment that wrote it (see
  the pivot bullet above). It's written carefully (multi-stage build, full
  monorepo copy in the build stage to avoid partial-workspace
  `npm ci`/lockfile-consistency issues, pruned `node_modules` copied into
  a clean runtime stage) but remains unverified; its own header comment
  says so and points at CI/`az acr build` as the actual verification
  point. Known accepted inefficiency: `npm prune --omit=dev` runs at the
  workspace root, so it prunes relative to *all* workspaces including
  `apps/dashboard` (react/vite deps) — the runtime image ships those
  unused prod deps too, since filtering `npm ci`/`prune` to a subset of
  workspaces risks the same lockfile-consistency problem a partial
  monorepo copy would. (`docker-compose.yml` no longer exists — replaced
  by the sibling-process `npm run dev`, see above.)
- **Integration tests: unit-level only, by design, given the sandbox
  gap.** `apps/coordinator/src/jira.test.ts` and `jiraMcpClient.test.ts`
  mock the MCP client/SDK entirely — no real network calls, matching the
  existing Classifier/Research testing pattern. No live-sandbox
  integration tests were written, since there's no sandbox to run them
  against; CLAUDE.md's "JIRA sandbox project key" open item is still
  unchecked (unchanged from Phase 3). Don't treat `npm run test` passing
  as evidence the real mcp-atlassian integration works — it only proves
  the code behaves correctly against the assumed (unverified)
  response shapes.

## Phase 5 — CI Pipeline

`.github/workflows/ci.yml` adds two jobs, triggered on every `pull_request`
to `main`:

- **`lint-and-test`** — `actions/checkout` + `actions/setup-node` (Node
  `20.x`, matching `engines.node` in root `package.json`), `npm ci` (this
  is an npm workspaces monorepo — one lockfile install covers every
  `apps/*`/`packages/*` workspace, not per-package installs), then the
  root `npm run lint` / `npm run typecheck` / `npm run test`. No per-app
  paths are hardcoded: `eslint .`, `tsc -b` (walks the whole TS
  project-references graph: `shared-types` → `anthropic-client` →
  `classifier`/`research` → `coordinator`, plus `apps/dashboard` as its
  own step per Phase 2's build-order decision), and the root
  `vitest.config.ts` glob already fan out across every workspace on their
  own — that's why this job is three plain root-script steps rather than
  a matrix or a set of per-workspace `-w` invocations. This job runs
  entirely against the mocked Anthropic-client and `JiraMcpClient` test
  doubles already in place from Phases 2–4; no real JIRA or Anthropic
  credentials are used or needed.
- **`docker-build-check`** — `needs: lint-and-test`, so it only runs once
  the first job is green. `docker build -f apps/coordinator/Dockerfile -t
  jira-triage-coordinator:ci .` (context is the repo root, matching the
  Dockerfile's own header comment about needing the whole workspace graph
  for `npm ci`/`tsc -b`). **This is the first time this Dockerfile has
  been built anywhere** — the dev VM that wrote it in Phase 4 has no
  Docker installed, so every claim in its comments (multi-stage build
  works, `npm prune --omit=dev` produces a runnable image, etc.) was
  reasoned through but never executed until this job exists.
  GitHub-hosted `ubuntu-latest` runners have Docker preinstalled, which is
  exactly why this validation was deferred to here rather than attempted
  locally. Build only — no push, no registry login, no container run step;
  proving the Dockerfile is valid is this job's entire purpose.

**Deliberately out of scope, per this phase's boundaries:**
- No registry push (ACR/GHCR) and no Azure/`az` CLI step anywhere in this
  workflow — that's Phase 6 (CD).
- No real JIRA credentials in the workflow. The "CI: ... a local
  mcp-atlassian instance pointed at a JIRA sandbox" line that used to be
  in "Environments and secrets" above was aspirational, not actually
  built — corrected there. No existing test suite requires live JIRA
  access (both `jira.test.ts` and `jiraMcpClient.test.ts` mock the MCP
  client entirely), so nothing had to be excluded from the required job;
  flagging this explicitly rather than silently discovering it later.
  Live-sandbox integration testing remains blocked on the same unchecked
  "JIRA sandbox project key" open item as every prior phase.
- No branch protection rules configured — `ci.yml`'s header comment notes
  that both jobs are *intended* as required status checks on `main`, but
  actually turning that on is a repo Settings change, not something to
  script into the workflow file.

**Verification status:** lint/typecheck/test pass locally
(`npm run lint`/`typecheck`/`test`, all green as of this writing) and the
Dockerfile's syntax/structure was reasoned through again while writing this
job, but **GitHub Actions workflows can't be meaningfully validated by
running or simulating them locally** — there's no local equivalent of a
GitHub-hosted runner's Docker environment or the `pull_request` trigger
context. The Phase 5 row in the roadmap table above stays "written,
unverified" until an actual PR shows both `lint-and-test` and
`docker-build-check` green.
