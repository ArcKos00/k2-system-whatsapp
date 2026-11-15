# ─── Build stage ───────────────────────────────────────────────
FROM 10.20.50.25:8081/node:26-bookworm-slim AS build
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
FROM 10.20.50.25:8081/node:26-bookworm-slim AS runtime
WORKDIR /app

# The Nexus base (Chromium, tini, K2 CA) is rebuilt rarely, while the Jenkins
# Trivy gate blocks CRITICALs that already have a fix. Pull Debian security
# updates (chromium, perl-base, libbrotli, ...). The job builds with --pull and layer cache, so this
# layer is reused until the base changes or BASE_REFRESH does: Jenkins passes the week number
# (--build-arg BASE_REFRESH="$(date +%G-W%V)"), so it is rebuilt with fresh patches once a week.
ARG BASE_REFRESH=none
RUN echo "base refresh: ${BASE_REFRESH}" \
    && apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Cap the Node heap well below the container memory limit (2Gi) so V8 GCs
# instead of being OOM-killed; the headless Chromium that whatsapp-web.js
# spawns lives outside this heap, so leave it ample headroom.
ENV NODE_ENV=production \
    WHATSAPP_SESSION_PATH=/app/data/sessions \
    NODE_OPTIONS=--max-old-space-size=1024

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Persisted WhatsApp session lives here — mount a volume to keep it.
# Code and node_modules stay root-owned (read-only for the process); only what the app writes belongs to
# node: the data volume and whatsapp-web.js's .wwebjs_cache, which it creates in the working directory.
# (chown -R /app used to copy all of node_modules into a ~40 MB layer of its own.)
RUN mkdir -p /app/data/sessions /app/.wwebjs_cache \
    && chown node:node /app/data /app/data/sessions /app/.wwebjs_cache
VOLUME ["/app/data"]

# Run as the non-root user that the node image ships with.
USER node

EXPOSE 3000

# tini (from the base image) reaps the headless-Chrome processes Puppeteer
# spawns and forwards SIGTERM (sent by Kubernetes on pod shutdown) to Node.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
