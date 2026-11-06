# ogygiaBench — hermetic image (Node + Chromium via Playwright + pnpm + bun)
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends unzip curl ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& curl -fsSL https://bun.sh/install | bash \
	&& ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
	&& ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx

# The build context is the repository root (the pnpm workspace); the app benchmark is suites/apps.
WORKDIR /bench
COPY . /bench

# corepack reads the pnpm version from package.json's `packageManager`.
RUN corepack enable && corepack install

# Point CHROME_PATH at Playwright's bundled Chromium.
RUN CHROME_BIN="$(ls -d /ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1)" \
	&& test -n "$CHROME_BIN" \
	&& ln -sf "$CHROME_BIN" /usr/local/bin/chrome

ENV CHROME_PATH=/usr/local/bin/chrome
# The harness is TypeScript run by plain node. Type stripping is on by default from Node 22.18;
# the flag covers an older Node in the base image and is harmless otherwise. CI=1 keeps pnpm
# non-interactive.
ENV NODE_OPTIONS=--experimental-strip-types
ENV CI=1

RUN pnpm install --prod --frozen-lockfile --config.confirmModulesPurge=false

RUN chmod +x /bench/suites/apps/docker-entrypoint.sh

CMD ["/bench/suites/apps/docker-entrypoint.sh"]
