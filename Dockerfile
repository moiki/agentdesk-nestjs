# ──────────────────────────────────────────────────────
# Stage 1: install all dependencies (including dev)
# ──────────────────────────────────────────────────────
FROM node:20-alpine AS deps

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

# Copy only package files first — maximises Docker layer cache
COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

# ──────────────────────────────────────────────────────
# Stage 2: build (prisma generate + nest build)
# ──────────────────────────────────────────────────────
FROM node:20-alpine AS build

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma Client (CJS, output to src/generated/prisma)
RUN npx prisma generate

# Build NestJS
RUN pnpm run build

# ──────────────────────────────────────────────────────
# Stage 3: production (minimal image)
# ──────────────────────────────────────────────────────
FROM node:20-alpine AS production

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# Add curl for healthcheck
RUN apk add --no-cache curl

WORKDIR /app

# Copy only what's needed at runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/generated/prisma ./src/generated/prisma
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./
COPY --from=build /app/package.json ./

# Non-root user
RUN addgroup -S agentdesk && adduser -S agentdesk -G agentdesk
USER agentdesk

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/main"]
