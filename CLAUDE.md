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
  API-token auth), run as a **sidecar container** alongside the Coordinator.
  We are explicitly NOT using Atlassian's official Rovo MCP Server, because
  its OAuth 2.1 flow requires interactive human consent and this service
  runs unattended on a webhook trigger.
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
  /coordinator      Main service: webhook handler (index.ts), orchestration +
                    business rules (triage.ts), JIRA write-back (jira.ts,
                    stubbed until Phase 4 — see "Decisions made in Phase 3")
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
tsconfig.base.json    Shared compilerOptions, extended by every package/app
tsconfig.json         Root TS project-references "solution" file (files: [],
                      references: [...]) — lets `tsc -b` build/typecheck the
                      whole graph in one command, in dependency order
```

## Data contracts (do not change shapes without updating shared-types first)

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

- **Local dev:** `.env.local` (gitignored) with dev-only keys, `docker-compose.yml`
  runs Coordinator + mcp-atlassian sidecar together for local testing.
- **CI:** no real secrets — unit/integration tests run against mocked
  Anthropic responses and a local mcp-atlassian instance pointed at a
  JIRA sandbox/test project, not production JIRA.
- **Production:** Azure Key Vault + managed identity. No secrets in
  GitHub Actions beyond what's needed for the OIDC federation itself.

## Build phases (see full plan in project notes — work one phase at a time)

0. This file
1. Repo scaffolding (empty apps, health checks, workspaces wired up)
2. Shared types + subagent logic (unit tested against schemas)
3. Coordinator orchestration (full loop, local mcp-atlassian, no prod JIRA)
4. Containerization (Dockerfiles + docker-compose for local dev)
5. GitHub Actions CI (lint/test/build on PR)
6. GitHub Actions CD (deploy to Azure Container Apps via OIDC)
7. OPTIONAL: React dashboard over the Cosmos DB audit log

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
