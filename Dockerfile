FROM node:26-alpine AS base

# pnpm from its official image
COPY --from=ghcr.io/pnpm/pnpm:12.16.1-alpine /opt/pnpm /opt/pnpm
RUN for bin in pnpm pn pnpx pnx; do ln -s "/opt/pnpm/$bin" "/usr/local/bin/$bin"; done

# Native packages can need libc compatibility
RUN apk add --no-cache libc6-compat

#
# Server build
#
FROM base AS server_deps
WORKDIR /app/server
COPY server/package.json server/pnpm-lock.yaml server/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Production-only server deps (for smaller runtime image)
FROM server_deps AS server_prod_deps
RUN pnpm prune --prod

FROM base AS server_builder
WORKDIR /app/server
COPY --from=server_deps /app/server/node_modules ./node_modules
COPY server/ ./

# Generate Prisma client and build Nest
RUN pnpm prisma generate
RUN pnpm build

# Ensure Prisma client artifacts are available alongside compiled JS output.
# (Nest build may not copy generated JS assets by default.)
RUN if [ -d src/generated ]; then mkdir -p dist/src && cp -R src/generated dist/src/; fi

#
# Web build
#
FROM base AS web_deps
WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
COPY web/vendor/ ./vendor/
RUN pnpm install --frozen-lockfile

FROM web_deps AS web_prod_deps
RUN pnpm install --prod --frozen-lockfile

FROM base AS web_builder
WORKDIR /app/web
COPY --from=web_deps /app/web/node_modules ./node_modules
COPY web/ ./

RUN pnpm build

#
# TanStack Start frontend for the Convex deployment
#
FROM base AS convex_web
WORKDIR /app
ARG SERVER_URL=http://convex:3211
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 SERVER_URL=$SERVER_URL

COPY --from=web_builder --chown=node:node /app/web/dist ./dist
COPY --from=web_builder --chown=node:node /app/web/start/serve.mjs ./start/serve.mjs
COPY --from=web_prod_deps --chown=node:node /app/web/node_modules ./node_modules

USER node
EXPOSE 3000
CMD ["node", "start/serve.mjs"]

#
# Runtime image (single container: postgres + api + web)
#
FROM postgres:18-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PGDATA=/data/postgres

# Bring Node runtime into the postgres image (same Alpine/musl family).
# Copy only the Node binary so we don't overwrite Postgres' own entrypoint scripts.
COPY --from=base /usr/local/bin/node /usr/local/bin/node

# curl for HEALTHCHECK, supervisor for process management
RUN apk add --no-cache curl supervisor libstdc++ libatomic libc6-compat

# Server runtime files
COPY --from=server_builder /app/server/dist ./server/dist
COPY --from=server_prod_deps /app/server/node_modules ./server/node_modules
COPY --from=server_builder /app/server/prisma ./server/prisma
COPY --from=server_builder /app/server/package.json ./server/package.json
COPY --from=server_builder /app/server/prisma.config.ts ./server/prisma.config.ts

# Web runtime files
COPY --from=web_builder /app/web/dist ./web/dist
COPY --from=web_builder /app/web/start/serve.mjs ./web/start/serve.mjs
COPY --from=web_prod_deps /app/web/node_modules ./web/node_modules

COPY docker/docker-entrypoint.sh /app/docker-entrypoint.sh
COPY docker/supervisord.conf /etc/supervisord.conf
RUN chmod +x /app/docker-entrypoint.sh

VOLUME ["/data"]

EXPOSE 3000

# Validates both web and API routing through the web API proxy (/api/*)
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=30s \
  CMD curl -f http://localhost:3000/api/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
