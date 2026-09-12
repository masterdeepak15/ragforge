# ============================================
# Stage 1: Build the frontend
# ============================================
FROM node:22-alpine AS frontend-builder

WORKDIR /app
COPY packages/web/package.json package-lock.json* ./
RUN npm ci
COPY packages/web/ ./
RUN npm run build

# ============================================
# Stage 2: Build the server
# ============================================
FROM node:22-alpine AS server-builder

WORKDIR /app
COPY packages/server/package.json package-lock.json* ./
RUN npm ci
COPY packages/server/ ./
RUN npm run build

# ============================================
# Stage 3: Production image
# ============================================
FROM node:22-alpine

RUN apk add --no-cache curl && rm -rf /var/cache/apk/*

WORKDIR /app

# Copy server build
COPY --from=server-builder /app/dist ./dist
COPY --from=server-builder /app/node_modules ./node_modules
COPY packages/server/package.json ./

# Copy frontend build into server's public dir
COPY --from=frontend-builder /app/dist ./packages/web/dist

# Copy shared package
COPY packages/shared ./packages/shared

# Entry point
CMD ["node", "dist/index.js"]
