FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/diagnostics/package.json packages/diagnostics/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/sync/package.json packages/sync/package.json
COPY packages/config/package.json packages/config/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS migrator
COPY . .
CMD ["pnpm", "--filter", "@masters/db", "db:migrate"]

FROM migrator AS postgres-ops
RUN apk add --no-cache postgresql18-client \
  && npm install --global pnpm@10.15.0

FROM deps AS builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 \
    DEPLOYMENT_MODE=club \
    AUTH_PROVIDER=better-auth \
    BETTER_AUTH_SECRET=build-only-secret-not-used-at-runtime-1234567890 \
    BETTER_AUTH_URL=http://127.0.0.1:3000 \
    NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000 \
    DATABASE_URL=file:/tmp/master-diagnostics-build.db \
    DATABASE_AUTH_TOKEN=
RUN pnpm --filter @masters/web build

FROM node:22-alpine AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]