FROM node:22-alpine AS server-deps

WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit

FROM node:22-alpine AS frontend-builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit
COPY vite.config.js ./
COPY client/ ./client/
RUN npm run build:docker

FROM node:22-alpine

ENV NODE_ENV=production \
    NODECRYPT_HOST=0.0.0.0 \
    NODECRYPT_PORT=8088 \
    NODECRYPT_DIST=/app/dist

WORKDIR /app
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/server.js ./server/server.js
COPY --from=frontend-builder /app/dist ./dist

EXPOSE 8088

CMD ["node", "--unhandled-rejections=strict", "server/server.js"]
