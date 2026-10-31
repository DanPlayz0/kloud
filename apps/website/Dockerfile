# Build from the repository root: docker build -f apps/website/Dockerfile .
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
COPY apps/website ./apps/website
RUN pnpm --filter @kloud/website run build

FROM nginxinc/nginx-unprivileged:stable-alpine AS runtime
ENV API_UPSTREAM=api:3000
COPY apps/website/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/website/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
