# ── Stage 1: dependencies ────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# Prevent puppeteer from downloading chrome during npm install
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN npm ci --omit=dev

# ── Stage 2: production image ────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Install Chromium and fonts needed for puppeteer headless browser
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont

# Set environment variables for puppeteer to use system chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy installed node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source
COPY . .

# Create uploads directory (will be mounted as a volume in docker-compose)
RUN mkdir -p uploads

EXPOSE 5000
CMD ["node", "server.js"]
