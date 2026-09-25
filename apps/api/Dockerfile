# Build context must be the monorepo root, e.g.:
#   docker build -f apps/api/Dockerfile -t amar-elaka-api .
# This uses `turbo prune` so the final image only contains apps/api's
# runtime dependencies, not the whole workspace.

FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
RUN corepack enable

# ---- Prune the workspace down to what apps/api actually needs ----
FROM base AS pruner
WORKDIR /app
RUN npm install -g turbo@^2.3.3
COPY . .
RUN turbo prune @amar-elaka/api --docker

# ---- Install deps and build ----
FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=@amar-elaka/api

# ---- Runtime image ----
FROM node:20-alpine AS runner
RUN apk add --no-cache dumb-init
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nestjs

COPY --from=builder --chown=nestjs:nodejs /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=nestjs:nodejs /app/apps/api/package.json ./apps/api/package.json
# pnpm symlinks each workspace package's own deps into its own node_modules,
# pointing back into the root .pnpm store — both directories are needed for
# Node's module resolution to actually find them at runtime.
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/apps/api/node_modules ./apps/api/node_modules

# STORAGE_DRIVER=local (ADR 028) keeps uploads here. Mount a persistent
# volume at /app/storage (Coolify: Persistent Storage) and mount the SAME
# volume into the worker container (same image, CMD node apps/api/dist/worker.js):
# the API writes originals, the worker reads them and writes the variants.
# Without a volume, every redeploy would delete every uploaded photo.
RUN mkdir -p /app/storage && chown nestjs:nodejs /app/storage

USER nestjs
ENV NODE_ENV=production
ENV STORAGE_LOCAL_PATH=/app/storage
EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/main.js"]
