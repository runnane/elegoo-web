# ── Build stage ────────────────────────────────────────────
FROM node:25-slim AS build

RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ── Production stage ──────────────────────────────────────
FROM node:25-slim

LABEL org.opencontainers.image.source=https://github.com/runnane/elegoo-web

RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copy built frontend + source (tsx runs .ts at runtime)
COPY --from=build /app/dist ./dist
COPY src ./src
COPY data/ai-labels.json ./data/ai-labels.json

ENV NODE_ENV=production
ENV PORT=8088
EXPOSE 8088 7125

CMD ["pnpm", "service"]
