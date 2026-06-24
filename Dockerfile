# syntax=docker/dockerfile:1

# Base image is built from Dockerfile.base and pushed to your own registry.
# It already provides Node, Chromium, tini and the internal CA certificates.
# Override at build time:
#   docker build --build-arg BASE_IMAGE=registry.k2.lan/whatsapp/base:20 .
ARG BASE_IMAGE=registry.k2.lan/whatsapp/base:20

# ─── Build stage ───────────────────────────────────────────────
FROM ${BASE_IMAGE} AS build
WORKDIR /app

# Don't download Chromium during build — the base image provides it.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY package*.json ./
RUN npm ci

COPY . .
# Generates src/generated/{routes.ts,swagger.json} then compiles to dist/.
RUN npm run build

# Drop dev dependencies for the runtime image.
RUN npm prune --omit=dev

# ─── Runtime stage ─────────────────────────────────────────────
FROM ${BASE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    WHATSAPP_SESSION_PATH=/app/data/sessions

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

# tini (from the base image) reaps the headless-Chrome processes Puppeteer
# spawns and forwards SIGTERM (sent by Kubernetes on pod shutdown) to Node.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
