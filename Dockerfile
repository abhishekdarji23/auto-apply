# ── Stage 1: install dependencies ──────────────────────────────────────────────
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ── Stage 2: build the Next.js app ─────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Provide a placeholder so mongodb.ts doesn't throw during static page collection.
# The real value is injected at runtime via env_file in docker-compose.yml.
ARG MONGODB_URI=mongodb://build-placeholder
ENV MONGODB_URI=$MONGODB_URI
RUN npm run build

# ── Stage 3: production runner ──────────────────────────────────────────────────
FROM node:20-slim AS runner
WORKDIR /app

# Install pdflatex (texlive) for resume generation
RUN apt-get update && apt-get install -y --no-install-recommends \
    texlive-latex-base \
    texlive-latex-recommended \
    texlive-latex-extra \
    texlive-fonts-recommended \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Next.js standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# ATS child-process scripts import packages that may not be traced into
# Next standalone output (for example axios in scripts/ats/AI/ats-llm-client.mjs).
# Copy full runtime node_modules so those imports are always available.
COPY --from=deps /app/node_modules ./node_modules

# Install Playwright browser binaries for fallback mode when CDP is unavailable.
RUN npx playwright install chromium

# Template JSON files needed at runtime (volume is initialised from image on first run)
COPY --from=builder /app/data/sample.json ./data/
COPY --from=builder /app/data/resume_sample.json ./data/
COPY --from=builder /app/data/resume_paginate_sample.json ./data/
COPY --from=builder /app/data/current-emails.json ./data/
# CSV used by top500 scripts
COPY ["Company_List - Sheet1.csv", "./"]

EXPOSE 3000

CMD ["node", "server.js"]
