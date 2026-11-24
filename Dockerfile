FROM node:22-bookworm-slim

ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN chown -R node:node /app
USER node

CMD ["npm", "start"]
