# Crumple × Sekisho — server + anvil (Base fork) in one container, for Railway.
# Node 22 (node:sqlite) · pnpm 10 via corepack · Foundry 1.4.4 (anvil) from the release tarball · tsx at runtime (no build step).

# ── 1. foundry binaries (anvil only) ───────────────────────────────────────────
FROM debian:bookworm-slim AS foundry
ARG FOUNDRY_VERSION=v1.4.4
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in amd64) ARCH=amd64 ;; arm64) ARCH=arm64 ;; *) echo "unsupported arch ${TARGETARCH}" && exit 1 ;; esac; \
    curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_${ARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin anvil cast; \
    /usr/local/bin/anvil --version

# ── 2. app ─────────────────────────────────────────────────────────────────────
FROM node:22-slim AS app
ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
# anvil needs libc + certs; git only because some deps' postinstall shell out to it
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.21.0 --activate

COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/cast /usr/local/bin/

WORKDIR /app
# manifests first so the install layer is cached across code changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/chain/package.json packages/chain/
COPY packages/course/package.json packages/course/
COPY packages/ens/package.json packages/ens/
COPY packages/intercepta/package.json packages/intercepta/
COPY packages/sekisho/package.json packages/sekisho/
COPY packages/world/package.json packages/world/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# devDependencies too: tsx/vite are dev deps and we run TypeScript straight through tsx
RUN pnpm install --frozen-lockfile --prod=false

COPY . .
# static arena bundle served by the server (apps/web/dist); tolerated if the web lane has no build yet
RUN pnpm --filter @crumple/web build || echo "web build skipped"

# anvil's fork cache (per pinned block) — mount a Railway volume here to keep upstream RPC load ~0 across restarts
ENV FOUNDRY_DIR=/root/.foundry

ENV PORT=8787
EXPOSE 8787
CMD ["pnpm", "--filter", "@crumple/server", "start"]
