# Multi-stage build for WhatsApp bot
FROM node:20-alpine AS build
ENV PUPPETEER_SKIP_DOWNLOAD=1
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production \
    DB_TYPE=sqlite \
    DB_PATH=/data/db.sqlite \
    WHATSAPP_AUTH_DIR=/session \
    STARTUP_NOTIFY_NUMBERS= \
    CHROMIUM_PATH=/usr/bin/chromium-browser
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    wqy-zenhei \
    ffmpeg \
 && addgroup -S app && adduser -S app -G app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Create expected dirs (ownership should be handled externally by the operator)
RUN mkdir -p /data /session /app/.wwebjs_auth
# Add entrypoint script that logs versions and then runs the app as non-root
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
VOLUME ["/data","/session"]
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
USER app
CMD ["node","dist/app.js"]
