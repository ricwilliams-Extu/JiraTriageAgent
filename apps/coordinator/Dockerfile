# Build context is the REPO ROOT, not this directory (e.g.
# `docker build -f apps/coordinator/Dockerfile .`) — the npm workspaces
# graph needs the whole monorepo to resolve symlinks and the `tsc -b`
# project-references chain.
#
# This dev VM has no Docker at all (not just "wasn't verified" — the
# `docker` CLI is unavailable), so this file cannot be build/run-tested
# locally in this phase, full stop. Validation happens in GitHub Actions CI
# (Phase 5) or via `az acr build` at deploy time (Phase 6), not
# `docker build` on a developer machine. Treat this as unverified until one
# of those actually runs it.

FROM node:20-slim AS build
WORKDIR /app

# Full monorepo copy, not a partial one: `npm ci` validates package.json
# against package-lock.json for every workspace declared in the root
# package.json's `workspaces` globs, so copying only a subset (e.g.
# omitting apps/dashboard) risks a lockfile-consistency failure. Multi-stage
# build discards this whole stage anyway, so the extra copied source (incl.
# apps/dashboard, never used by Coordinator) costs nothing in the final
# image.
COPY . .

RUN npm ci

# tsc -b's project-references graph means building just the coordinator
# workspace transitively builds shared-types, anthropic-client, classifier,
# and research too.
RUN npm run build -w apps/coordinator

# Prune devDependencies in place, then copy the already-installed (now
# pruned) node_modules into the runtime stage — avoids a second `npm ci`
# there, which would hit the same partial-workspace-lockfile question.
# Note: this prunes relative to ALL workspaces (including apps/dashboard's
# react/vite deps, unused by Coordinator), not just the ones this image
# needs — an accepted size inefficiency for this phase, not a correctness
# issue; see CLAUDE.md's "Decisions made in Phase 4."
RUN npm prune --omit=dev

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared-types/package.json ./packages/shared-types/package.json
COPY --from=build /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=build /app/packages/anthropic-client/package.json ./packages/anthropic-client/package.json
COPY --from=build /app/packages/anthropic-client/dist ./packages/anthropic-client/dist
COPY --from=build /app/apps/classifier/package.json ./apps/classifier/package.json
COPY --from=build /app/apps/classifier/dist ./apps/classifier/dist
COPY --from=build /app/apps/research/package.json ./apps/research/package.json
COPY --from=build /app/apps/research/dist ./apps/research/dist
COPY --from=build /app/apps/coordinator/package.json ./apps/coordinator/package.json
COPY --from=build /app/apps/coordinator/dist ./apps/coordinator/dist

EXPOSE 3000
CMD ["node", "apps/coordinator/dist/index.js"]
