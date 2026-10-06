# syntax=docker/dockerfile:1

# ============================================
# Stage 1: install, build shared + server + web
# ============================================
FROM node:22-alpine AS build

WORKDIR /app

# Install first (cache-friendly): the workspace manifests are enough for `npm ci`.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY packages ./packages
# Order matters: server and web import @ragforge/shared's compiled output.
RUN npm run build --workspace=@ragforge/shared \
 && npm run build --workspace=@ragforge/server \
 && npm run build --workspace=@ragforge/web

# Keep only what runs in production.
RUN npm prune --omit=dev

# ============================================
# Stage 2: runtime image
# ============================================
FROM node:22-alpine

RUN apk add --no-cache curl tini

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    SQLITE_URL=file:/data/ragforge.db

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/bin ./packages/server/bin
COPY --from=build /app/packages/web/dist ./packages/web/dist

# Uploads and the database live in /data; mount a volume there.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:8080/api/ready || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/server/bin/ragforge.js"]
