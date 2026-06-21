# syntax=docker/dockerfile:1

# ─── Build stage ───────────────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Don't download Chromium during build — runtime image provides it.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY package*.json ./
RUN npm ci

COPY . .
# Generates src/generated/{routes.ts,swagger.json} then compiles to dist/.
RUN npm run build

# Drop dev dependencies for the runtime image.
RUN npm prune --omit=dev

# ─── Runtime stage ─────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    WHATSAPP_SESSION_PATH=/app/data/sessions

# Chromium + the fonts/libs whatsapp-web.js needs to render.
# tini is PID 1 to forward signals and reap zombie Chrome child processes.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini \
      chromium \
      ca-certificates \
      fonts-liberation \
      libnss3 \
      libatk-bridge2.0-0 \
      libgtk-3-0 \
      libxss1 \
      libasound2 \
      libgbm1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Persisted WhatsApp session lives here — mount a volume to keep it.
RUN mkdir -p /app/data/sessions
VOLUME ["/app/data"]

# Run as the non-root user that the node image ships with.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# tini reaps the headless-Chrome processes Puppeteer spawns and forwards
# SIGTERM (sent by Kubernetes on pod shutdown) to Node for graceful exit.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
