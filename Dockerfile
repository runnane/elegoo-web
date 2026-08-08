# ── Build stage ────────────────────────────────────────────
# node 26 is the LTS line (LTS 2026-10-28, supported to 2029-04-30) and is what this
# service already runs on metal — the container and the host should not diverge.
#
# NOT node 25: an odd release that was never going to be LTS, and EOL since 2026-06-01,
# so it receives no security fixes at all. Dependabot moved this base from node:22-slim
# (LTS, supported to 2027-04-30) in #10, which traded a supported release for an EOL one
# AND broke the build, because 25 dropped the bundled corepack (ELEG-69). Keep this on an
# even major; dependabot.yml no longer proposes docker majors, for that reason.
FROM node:26-slim AS build

WORKDIR /app

# pnpm-workspace.yaml is REQUIRED, not optional. Since ELEG-4 it holds `overrides`
# (including the ELEG-63 security floors) and `onlyBuiltDependencies`; pnpm 11 stopped
# reading the `pnpm` field in package.json. Omit it and --frozen-lockfile correctly
# refuses the mismatch against pnpm-lock.yaml.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# pnpm comes from `packageManager` in package.json, so the image builds with the exact
# version developers and CI use — the single-source-of-truth property ELEG-4 established.
#
# Installed directly rather than through corepack. Node 25 no longer bundles corepack
# (`corepack: not found` is where this image stopped building the moment #10 bumped the
# base from node:22-slim — see ELEG-69), and `npm i -g corepack@latest` does not rescue
# it: the current corepack declares `^22.22.2 || ^24.15.0 || >=26.0.0`, which skips 25,
# and then fails EEXIST on /usr/local/bin/yarnpkg. One less moving part this way.
#
# NOT `pnpm@latest`. That is the same mistake `version: latest` was in ci.yml, which
# silently moved to pnpm 11 and broke the frozen install two different ways (ELEG-4).
RUN PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1]")" \
 && npm i -g "pnpm@${PNPM_VERSION}" \
 && pnpm --version

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ── Production stage ──────────────────────────────────────
FROM node:26-slim

LABEL org.opencontainers.image.source=https://github.com/runnane/elegoo-web
LABEL org.opencontainers.image.description="Web frontend and service for the Elegoo Centauri Carbon 2 printer"
LABEL org.opencontainers.image.licenses=MIT

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1]")" \
 && npm i -g "pnpm@${PNPM_VERSION}" \
 && pnpm --version
RUN pnpm install --frozen-lockfile --prod

# Built frontend + source. tsx runs the TypeScript directly at runtime, which is why
# src/ ships rather than a compiled server bundle — same as production on metal.
COPY --from=build /app/dist ./dist
COPY src ./src

# NOTE: no `COPY data/…` here. `data/` is the runtime DATA_DIR (and is gitignored), so
# it does not exist in a clean clone — that COPY was the second reason this image could
# not be built from a fresh checkout. `ai-labels.json` needs no seeding: the AI monitor
# falls back to `buildDefaultLabelConfigs()` and writes the file into DATA_DIR itself.

# The deploy stamp, the same shape contrib/install.sh writes on metal (ELEG-10) and the
# same one the UI renders as x.y.z+aa (ELEG-48). Without it a container reports
# "unknown", which is honest but useless when someone opens an issue — "which build are
# you running?" is the first question, and a public image needs to answer it itself.
#
# Deliberately the LAST layer: these args change on every commit, so anything below them
# would be rebuilt every time. Empty stays null, matching install.sh, so an unstamped
# local `docker build` still degrades to "unknown" rather than lying.
ARG BUILD_COMMIT=""
ARG BUILD_DESCRIBE=""
ARG BUILD_VERSION=""
ARG BUILD_TIME=""
RUN node -e 'const f=v=>v&&v.length?v:null; require("fs").writeFileSync("build-info.json", JSON.stringify({commit:f(process.env.BUILD_COMMIT),shortCommit:f((process.env.BUILD_COMMIT||"").slice(0,7)),describe:f(process.env.BUILD_DESCRIBE),version:f(process.env.BUILD_VERSION),installedAt:f(process.env.BUILD_TIME)},null,2)+"\n")' \
 && cat build-info.json

ENV NODE_ENV=production
ENV PORT=8088
EXPOSE 8088 7125

CMD ["pnpm", "service"]
