# syntax=docker/dockerfile:1

# ---- build stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Native modules (better-sqlite3, sharp) need build tooling on some platforms.
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

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server
COPY content ./content

# Writable volumes: the SQLite database and uploaded chapter content.
RUN mkdir -p /app/data && chown -R node:node /app/data /app/content
VOLUME ["/app/data", "/app/content"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
