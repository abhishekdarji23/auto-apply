# ──────────────────────────────────────────────
# Stage 1 – deps only (cached layer)
# ──────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.52.0-jammy AS deps

WORKDIR /app
COPY ../../package*.json ./
RUN npm install --omit=dev

# ──────────────────────────────────────────────
# Stage 2 – runtime
# ──────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app

# Copy installed deps
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# In Docker we MUST run headless (no display server)
ENV HEADLESS=true
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]