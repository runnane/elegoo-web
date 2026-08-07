#!/usr/bin/env bash
# The gate set, in one place.
#
#   pnpm gates          # everything
#   pnpm gates --fix    # `biome check --write` first, then everything
#
# These are the checks .github/workflows/ci.yml runs, in the same order, PLUS ONE:
# `service:check`. That is not an accident — tsconfig.json excludes src/server and
# src/telegram, and CI only ever runs the build (which uses that config), so the
# entire backend is typechecked by nothing in CI. Production runs the TypeScript
# directly under `node --import tsx`, so a type error there reaches the running
# service without a compile step in between.
#
# On biome: CI runs the NON-writing `biome ci`. `pnpm check` auto-fixes and exits 0,
# so an auto-fix you did not commit still fails CI's lint step — hence --fix runs the
# writer first and then re-checks, and you commit what it rewrote.
#
# What this cannot check is in .claude/commands/local/gates.md: there are six tests in
# this repo, no browser test at all, and no gate on earth can tell you whether a
# change does the right thing to a physical printer.

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

if [ "$fix" = 1 ]; then
  printf '\n\033[1m▶ biome check --write\033[0m  (fixing before the gates)\n'
  pnpm check || true
fi

# Order mirrors ci.yml: cheapest signal first.
run 'biome ci (non-writing, as CI runs it)' pnpm exec biome ci src/
run 'typecheck: browser half (tsconfig.json)' pnpm exec tsc
run 'typecheck: service + telegram (NOT run by CI)' pnpm run service:check
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
printf '\033[2mSix tests and no browser check — see .claude/commands/local/gates.md for what this does NOT prove.\033[0m\n'
if [ "$fix" = 0 ]; then
  echo 'Reminder: if you edit anything else, re-run `pnpm gates --fix` and commit what biome rewrites.'
fi
