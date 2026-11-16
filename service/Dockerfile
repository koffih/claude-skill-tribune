FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.js ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8790
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY sql ./sql
COPY package.json ./
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8790${TRIBUNE_BASE_PATH:-}/healthz || exit 1
CMD ["node", "dist/server/main.js"]
