# Build from the repository root: docker build -f apps/connector/Dockerfile .
FROM node:26-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@12.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/website/package.json ./apps/website/package.json
COPY apps/connector/package.json ./apps/connector/package.json
COPY apps/protocol ./apps/protocol
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY apps/connector/tsconfig.json ./apps/connector/tsconfig.json
COPY apps/connector/src ./apps/connector/src
RUN pnpm --filter @dedi-dash/connector run build

FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV API_URL=http://api:3000
ENV HEALTH_PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/protocol ./apps/protocol
COPY --from=build --chown=node:node /app/apps/connector/node_modules ./apps/connector/node_modules
COPY --from=build --chown=node:node /app/apps/connector/package.json ./apps/connector/package.json
COPY --from=build --chown=node:node /app/apps/connector/dist ./apps/connector/dist
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.HEALTH_PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "apps/connector/dist/index.js"]
