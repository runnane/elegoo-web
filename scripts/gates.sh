#!/usr/bin/env bash
# The gate set, in one place.
#
#   pnpm gates          # everything
#   pnpm gates --fix    # `biome check --write` first, then everything
#
# THIS FILE IS WHAT CI RUNS (ELEG-5). .github/workflows/ci.yml is one step,
# `pnpm gates`, so this script is the single list of what has to pass and the two
# cannot drift apart. Add a gate here and CI picks it up with no workflow edit.
#
# It used to be four hand-listed steps in ci.yml, which is how `service:check` came
# to be missing from them: tsconfig.json excludes src/server, CI only
# ran the build (which uses that config), and so the entire backend was typechecked by
# nothing in CI. Measured at the time — a deliberate type error in src/server/config.ts
# left `pnpm build` PASSING and only `service:check` caught it. Production runs the
# TypeScript directly under `node --import tsx`, so such an error reaches the running
# service with no compile step in between.
#
# On biome: CI runs the NON-writing `biome ci`. `pnpm check` auto-fixes and exits 0,
# so an auto-fix you did not commit still fails CI's lint step — hence --fix runs the
# writer first and then re-checks, and you commit what it rewrote.
#
# NOTE the deliberate absence of a path argument (ELEG-79). A path narrows the file set
# and SILENTLY OVERRIDES biome.json's `includes`, with no warning that it did. This ran
# `biome ci src/` while `includes` said `src/**`, so the two agreed by accident and the
# root config files were linted by nothing — `biome ci src/` checked 84 files and passed
# while `biome ci` checked 87 and found real formatting drift in both. Scope belongs in
# biome.json alone; do not reintroduce a path here or in package.json's biome scripts.
#
# What this cannot check is in .agents/gates.md. In short: the suite is
# small and almost entirely pure functions, nothing exercises a connection or a route,
# there is no browser and no screenshot, and no gate on earth can tell you whether a
# change does the right thing to a physical printer.
#
# Deliberately no test count here or in the footer — vitest prints one two lines above it
# every run. A number in a string that nothing updates only ever drifts (ELEG-15).

set -uo pipefail
cd "$(dirname "$0")/.."

fix=0
for arg in "$@"; do
  case "$arg" in
    --fix) fix=1 ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

failed=()
passed=()

run() {
  local label="$1"
  shift
  printf '\n\033[1m▶ %s\033[0m  (%s)\n' "$label" "$*"
  if "$@"; then
    passed+=("$label")
  else
    failed+=("$label")
  fi
}

# pnpm-lock.yaml must stay ONE YAML document (ELEG-138). pnpm 12, invoked directly as
# pnpm/action-setup runs it, prepends a `packageManagerDependencies` document unless
# `pmOnFail: ignore` is set in pnpm-workspace.yaml. GitHub's dependency graph reads only
# the first document, so a second one silently blinds Dependabot on this public repo —
# and nothing else here would notice. Any line that is a bare `---` or `...` fails.
lockfile_single_document() {
  local markers
  if [ ! -f pnpm-lock.yaml ]; then
    echo 'pnpm-lock.yaml is missing. Never delete it: the overrides in it are security pins.'
    return 1
  fi
  markers="$(grep -nE '^(---|\.\.\.)([[:space:]]|$)' pnpm-lock.yaml)"
  if [ -n "$markers" ]; then
    echo "pnpm-lock.yaml has YAML document markers (GitHub reads only the first document):"
    echo "$markers"
    echo "Is \`pmOnFail: ignore\` still in pnpm-workspace.yaml? See .agents/gates.md (ELEG-138)."
    return 1
  fi
  echo 'pnpm-lock.yaml is one YAML document (no ---/... markers).'
}

# The running pnpm's major must match `packageManager` (ELEG-138). `pmOnFail: ignore`
# is what keeps the lockfile one document, and its cost is that pnpm 12 no longer
# switches itself to the pinned version — a different global pnpm just runs. A patch or
# minor drift is harmless; a major one is how CI and developers diverged before (ELEG-4).
pnpm_major_matches_pin() {
  local pin running
  pin="$(node -p "require('./package.json').packageManager.replace(/^pnpm@/, '')")"
  running="$(pnpm --version)"
  if [ "${running%%.*}" != "${pin%%.*}" ]; then
    echo "running pnpm ${running} does not match packageManager pnpm@${pin} (major ${pin%%.*})."
    echo "Install the pinned major (e.g. \`npm i -g pnpm@${pin}\`); pmOnFail: ignore means pnpm will not switch for you."
    return 1
  fi
  echo "running pnpm ${running}, packageManager pnpm@${pin}: same major."
}

# biome.json's `$schema` must not name a different version than the installed CLI
# (ELEG-195, same shape as ELEG-111). Dependabot bumps @biomejs/biome and never touches
# a versioned schema URL, and biome reports the mismatch as an INFO diagnostic that
# `biome ci` exits 0 on — so it recurs on every bump and nothing else here notices.
# Accepted: the installed package's own schema (`./node_modules/@biomejs/biome/...`,
# which cannot drift, and is what biome.json uses), or a versioned URL equal to
# `biome --version`. Anything else, including a schema this cannot parse, fails.
biome_schema_matches_cli() {
  local schema cli
  schema="$(node -p "require('./biome.json').\$schema || ''")"
  cli="$(pnpm exec biome --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)"
  if [ -z "$cli" ]; then
    echo 'could not read the installed biome version from `pnpm exec biome --version`.'
    return 1
  fi
  case "$schema" in
    ./node_modules/@biomejs/biome/configuration_schema.json)
      if [ ! -f "$schema" ]; then
        echo "biome.json \$schema points at ${schema}, which does not exist (run pnpm install)."
        return 1
      fi
      echo "biome.json \$schema is the installed package's own schema (CLI ${cli}): cannot drift."
      ;;
    https://biomejs.dev/schemas/*/schema.json)
      local ver="${schema#https://biomejs.dev/schemas/}"
      ver="${ver%/schema.json}"
      if [ "$ver" != "$cli" ]; then
        echo "biome.json \$schema names biome ${ver} but the installed CLI is ${cli}."
        echo "Run \`pnpm exec biome migrate --write\`, or point \$schema at ./node_modules/@biomejs/biome/configuration_schema.json (ELEG-195)."
        return 1
      fi
      echo "biome.json \$schema ${ver} matches the installed CLI ${cli}."
      ;;
    *)
      echo "biome.json \$schema is '${schema}', which this check does not recognise."
      echo "Use ./node_modules/@biomejs/biome/configuration_schema.json or https://biomejs.dev/schemas/${cli}/schema.json."
      return 1
      ;;
  esac
}

if [ "$fix" = 1 ]; then
  printf '\n\033[1m▶ biome check --write\033[0m  (fixing before the gates)\n'
  pnpm check || true
fi

# Order mirrors ci.yml: cheapest signal first.
run 'lockfile is one YAML document' lockfile_single_document
run 'pnpm major matches packageManager' pnpm_major_matches_pin
run 'biome.json $schema matches the CLI' biome_schema_matches_cli
run 'biome ci (non-writing, as CI runs it)' pnpm exec biome ci
run 'typecheck: browser half (tsconfig.json)' pnpm exec tsc
run 'typecheck: service half (tsconfig.server.json)' pnpm run service:check
# Dead-code check (ELEG-65). Neither typecheck complains about a module nothing
# imports, and `vite build` tree-shakes it out SILENTLY — so an unreachable file
# survives looking perfectly legitimate. Four have been found that way, all by hand.
# Scoped to `files` only: unused *exports* are noisy here because dashboard.ts
# re-exports a barrel, and a check that cries wolf gets ignored. See .agents/gates.md.
run 'dead code (knip)' pnpm exec knip --no-config-hints
run 'build (vite)' pnpm exec vite build
run 'unit tests (vitest)' pnpm exec vitest run

printf '\n\033[1m── gates ──\033[0m\n'
for g in "${passed[@]:-}"; do [ -n "$g" ] && printf '\033[32m  ✓ %s\033[0m\n' "$g"; done
for g in "${failed[@]:-}"; do [ -n "$g" ] && printf '\033[31m  ✗ %s\033[0m\n' "$g"; done

if [ "${#failed[@]}" -gt 0 ]; then
  printf '\n\033[31m%d gate(s) failed — fix before opening a PR.\033[0m\n' "${#failed[@]}"
  exit 1
fi
printf '\n\033[32mAll gates green.\033[0m\n'
printf '\033[2mNo browser and no screenshot — see .agents/gates.md for what this does NOT prove.\033[0m\n'
if [ "$fix" = 0 ]; then
  echo 'Reminder: if you edit anything else, re-run `pnpm gates --fix` and commit what biome rewrites.'
fi
