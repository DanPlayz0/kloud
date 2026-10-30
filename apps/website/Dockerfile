# Build from the repository root: docker build -f apps/website/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/website/package.json ./apps/website/package.json
RUN npm ci --workspace @dedi-dash/website --include-workspace-root
COPY tsconfig.base.json ./
COPY apps/website ./apps/website
# Vite generates the TanStack route tree before TypeScript checks it.
RUN npm exec --workspace @dedi-dash/website -- vite build \
    && npm run typecheck --workspace @dedi-dash/website

FROM nginxinc/nginx-unprivileged:stable-alpine AS runtime
ENV API_UPSTREAM=api:3000
COPY apps/website/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/website/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
