# ---- Network Monitoring Dashboard ----
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (secrets are excluded via .dockerignore)
COPY . .

# history data dir (also mounted as a volume by docker-compose)
RUN mkdir -p /app/history

EXPOSE 8080

CMD ["node", "dashboard.js"]
