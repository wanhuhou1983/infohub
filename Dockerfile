# ===== Stage 0: Quality Gate =====
# Catches TS type errors and inline JS syntax errors BEFORE building the production image
FROM oven/bun:1.3-alpine AS check
WORKDIR /app

# Install ALL deps (including devDeps: typescript, @types/node for tsc)
COPY backend/package.json backend/bun.lock ./
RUN bun install

# Copy source and run tsc (type check only, no emit)
COPY backend/ ./
RUN bun x tsc --noEmit

# JS syntax check for inline scripts in HTML frontend files
COPY frontend/ /app/frontend/
COPY scripts/check-html-js.sh /app/scripts/check-html-js.sh
RUN sh /app/scripts/check-html-js.sh /app/frontend/index.html /app/frontend/infohub-admin.html


# ===== Stage 1: Production dependencies =====
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY backend/package.json backend/bun.lock ./
RUN bun install --frozen-lockfile --production


# ===== Stage 2: Production image =====
FROM oven/bun:1.3-alpine

RUN apk add --no-cache python3 py3-pip py3-requests py3-beautifulsoup4
RUN apk add --no-cache tzdata

WORKDIR /app

COPY backend/package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY backend/ ./

WORKDIR /app
COPY frontend/ /app/frontend/

EXPOSE 3001

CMD ["bun", "run", "index.ts"]
