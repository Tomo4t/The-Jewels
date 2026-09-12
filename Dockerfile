# syntax=docker/dockerfile:1

# ---- build stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Native modules (better-sqlite3, sharp) may need to compile on some platforms.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# ---- runtime stage ---------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ util-linux \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server

# The chapters committed to the repo ship as a read-only baseline. On first boot
# the server copies them into CONTENT_DIR, which on a managed host is an empty
# persistent volume. Later boots leave the volume untouched.
COPY content ./content-baseline

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# All writable state lives under one directory, so this fits hosts that allow
# only a single volume per service:
#   /data/jewels.db   the database
#   /data/content     chapters and updates, including everything uploaded
RUN mkdir -p /data/content && chown -R node:node /data
VOLUME ["/data"]

ENV DATABASE_PATH=/data/jewels.db \
    CONTENT_DIR=/data/content \
    CONTENT_BASELINE_DIR=/app/content-baseline

# Deliberately no `USER node`: the entrypoint starts as root only long enough to
# take ownership of the mounted volume, then drops to the node user itself.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
