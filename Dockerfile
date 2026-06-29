# ─── Build stage ───────────────────────────────────────────────
FROM 10.20.50.25:8081/node:20-bookworm-slim AS build
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
FROM 10.20.50.25:8081/node:20-bookworm-slim AS runtime
WORKDIR /app

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
