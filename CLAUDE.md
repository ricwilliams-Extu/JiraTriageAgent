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
  /coordinator      Main service: webhook handler, orchestration, JIRA write-back
  /classifier        Subagent module (called by Coordinator, in-process or via Agent SDK Task)
  /research           Subagent module (same)
  /dashboard          OPTIONAL React + Vite app, read-only view over the audit log
/packages
  /shared-types       Zod schemas for Ticket, ClassificationResult, ResearchResult
/.github/workflows
  ci.yml              Runs on every PR: install, lint, typecheck, unit test, build
  deploy.yml          Runs on merge to main: build/push images, deploy to Azure
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

- Node LTS version: [fill in — e.g. 20.x]
- Package manager: npm (workspaces), not yarn/pnpm
- Linting: ESLint + Prettier, config at repo root, shared across all apps
- Testing: [fill in — e.g. Vitest], unit tests colocated with source
  (`*.test.ts`), integration tests in a top-level `/tests` dir
- All Anthropic API / Agent SDK calls should be wrapped in a thin client
  module (not scattered `fetch` calls) so retry/error handling lives in
  one place
- Structured logging (not `console.log`) — [fill in tool, e.g. pino] —
  every log line for a ticket should include the ticket key for traceability

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

- [ ] Node LTS version to pin
- [ ] Test framework choice (Vitest recommended, not required)
- [ ] Logging library choice
- [ ] Azure subscription / resource group names for the target environment
- [ ] JIRA sandbox project key to use in CI integration tests
