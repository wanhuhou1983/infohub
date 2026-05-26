FROM oven/bun:1.3-alpine AS deps

WORKDIR /app

COPY backend/package.json backend/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-alpine

RUN apk add --no-cache python3 py3-pip py3-requests py3-beautifulsoup4

WORKDIR /app

COPY backend/package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY backend/ ./

WORKDIR /app
COPY frontend/ /app/frontend/

EXPOSE 3001

CMD ["bun", "run", "index.ts"]
