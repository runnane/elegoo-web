# Deployment — and why `MERGED` is not `IN_PRODUCTION`

Production for this repo runs **on the same machine you develop on**. That is still the
single most important thing on this page — your checkout and `/opt/elegooweb` (the live
service) are different trees that can silently disagree.

**Since ELEG-108 (2026-09-16) production is a Docker Compose stack, not the systemd
unit.** `elegooweb.service` is stopped and disabled; its unit file and `/opt/elegooweb/src`
are kept on disk for rollback until an operator cleans them up, but neither is what is
running. Reasoning about this host from the old systemd shape — or handing an operator
`sudo pnpm service:install` as the deploy command — is now wrong: that would rsync the
checkout over the stack root and restart a unit that is meant to stay off.

## What is actually running

| | |
| --- | --- |
| mechanism | Docker Compose, `/opt/elegooweb/compose.yml` |
| container | `elegoo-web`, image `ghcr.io/runnane/elegoo-web:latest` |
| restart policy | `restart: unless-stopped` |
| user | **root inside the container** — the `Dockerfile` has no `USER` directive. Known regression from the systemd unit's `NoNewPrivileges`/`ProtectSystem=strict`/`ProtectHome` hardening; not fixed by this issue |
| ports | `8088` and `7125` published on **all interfaces** (`0.0.0.0`), same as the systemd unit's default bind |
| env | `env_file: .env` (that `.env` is at `/opt/elegooweb/.env`, separate from the checkout's) plus one override: `environment: DATA_DIR=/app/data` — `environment:` wins over `env_file:`, so a `DATA_DIR` set in `.env` cannot leak into the container's path layout |
| volumes | `/opt/elegooweb/data`, `/opt/elegooweb/.cache` and `/opt/elegooweb/.env` bind-mounted from the same directory the systemd install used — `data/`, `.cache/` and `.env` never moved |
| build | there is **no build step on this host any more** — the image is built by CI and pulled. The frontend and backend both ship inside it |

`elegooweb.service` is confirmed `disabled`/`inactive` on this host (`systemctl
is-enabled` / `is-active`, read 2026-09-16); its unit file and `/opt/elegooweb/src` are
kept only as the rollback path below, not as a second running copy.

There is also the systemd installer (`contrib/install.sh`, `sudo pnpm service:install`)
— it is real, it is a supported path for other users' hosts, and `README.md` documents
it. **It is not what deploys this host.** Don't hand an operator that command for a
deploy here.

## How a deploy happens

Pull first, then recreate — never stop before the pull completes:

```bash
sudo docker compose -f /opt/elegooweb/compose.yml pull
sudo docker compose -f /opt/elegooweb/compose.yml up -d
```

or the equivalent one-liner, which pulls while the old container keeps serving and only
the recreate is a gap:

```bash
sudo docker compose -f /opt/elegooweb/compose.yml up -d --pull always
```

`sudo` is required because the compose CLI itself reads `.env`, which is `600`.

**Pull-before-stop is measured, not a guess.** The ELEG-108 migration stopped systemd
before the image pull had finished, and the service was down for **6.7 minutes**
(measured from the persistence layer's restored-state age). The very next update, done
in the correct order, had a **10-second** gap — the recreate itself, nothing else. Same
host, same image size difference in cause.

CI publishes `ghcr.io/runnane/elegoo-web:latest` on every merge to `main` (multi-arch:
`linux/amd64` and `linux/arm64`), so `up -d --pull always` — or the two-step form above
— picks up whatever most recently merged.

**Every published image is stamped.** `.release-it.json` used to carry docker hooks that
pushed an unstamped, amd64-only image over `:latest` and `:x.y.z` at release time, racing
CI for the same tags — the v1.0.0 migration pulled one of those and ran it for an hour.
ELEG-110 deleted the hooks; since then `publish.yml` is the only thing that writes the
registry, on every `main` push and on every release tag (dispatched explicitly by
`release.yml`, ELEG-112). An all-null stamp now means an image built locally with
`docker build`, not a release.

### Three consequences carried over from the systemd era, re-stated for compose

1. **Delete-consistency is no longer a concern at all.** The systemd installer's
   `rsync -a --delete` existed to stop a file removed from git surviving forever in
   `/opt/elegooweb/src`. An image pull replaces the whole filesystem atomically — there
   is nothing to leave behind. (The **leftover** `src/`, `dist/` etc. that the systemd
   install used to write are still on disk, per the rollback note below, but they are
   inert — nothing reads them while the container is what's running.)
2. **The stamp is now answered by the image, not a written file.** `build-info.json` is
   baked into the image at CI build time (same shape `contrib/install.sh` used to write
   on metal) and served from `/api/health` as `.build`, exactly as before:
   ```bash
   curl -s localhost:8088/api/health | jq .build
   # {"commit":"6928f3e6…","shortCommit":"6928f3e","describe":"v1.0.0-16-g6928f3e","version":"1.0.0","installedAt":"2026-09-16T07:01:05Z"}
   ```
   All-null still means unstamped — a locally built image (`pnpm docker:build`), or
   one from before ELEG-110 that has not been re-pulled. When the stamp is null, fall
   back to the image digest (see "Operator commands" below).
3. **`.env` divergence is unchanged.** `/opt/elegooweb/.env` is still a different file
   from the one you test with, compose still only ever reads it (never writes it), and
   a new `config.ts` key still defaults silently in production until someone adds it
   there. `up -d` (without `--force-recreate`) does not even notice an `.env` edit
   unless the container is recreated — an env-only change needs `up -d` run again after
   editing the file, same as before.

## Exposure is decided outside this repo

The service binds `0.0.0.0` by default and has **no authentication of any kind** (see
[security.md](security.md)), so what limits who can reach it is entirely the network
around it: a reverse-proxy vhost and DNS, both configured in the **`~/ansible` (ANS)**
repo rather than here. A change to *who can reach it* is therefore an ANS issue, and the
specifics for a given deployment belong in the **ELEG tracker**, deliberately not in this
public repository. Compose publishing the same two ports on all interfaces changes
nothing about this section.

`BIND_ADDRESS` (ELEG-93) makes the bind configurable — both `SERVICE_PORT` and
`MOONRAKER_PORT` listen on it — but the default is still `0.0.0.0`, so **this alone
changes nothing for this deployment**. Whether production should actually narrow it
(loopback-only, one interface) is ELEG-94's decision, not this repo's default. Inside
the container, narrowing the bind still needs the *published* port range narrowed too
(`ports:` in `compose.yml`), or the container keeps listening on every interface
regardless of what the app binds to internally.

Two consequences for anyone testing this:

- **A request from the host itself proves nothing about reachability.** `curl` and any
  local fetch tool resolve and route from inside the network, so a `200` says only that
  the service is up — not that anyone else can get to it. Answering "is this exposed?"
  needs a resolver check (what does public DNS return — a routable address or an RFC1918
  one?) and, for reachability, a client genuinely off the network.
- **The proxy is not the only door.** Because the bind defaults to `0.0.0.0`, ports 8088
  and 7125 are directly reachable from anything routed to the host, bypassing whatever
  vhost or auth the proxy might add — unless `BIND_ADDRESS` has been narrowed (ELEG-94).

Read [security.md](security.md) before adding an endpoint: what protects this service is
network position, not code.

## Operator commands

These are the ones worth pasting into an `OPERATOR:` issue. All of them are for a
human on this host; an agent may read (`docker ps`, `docker logs`, `curl`) but does not
pull, recreate, stop or restart the container, and does not run `docker compose
up`/`down`/`pull`/`restart` on this host.

```bash
# what is running, and since when
docker ps --filter name=elegoo-web
docker logs elegoo-web --tail 100

# is production the same code as origin/main?
curl -s localhost:8088/api/health | jq .build
# compare .build.commit against: git rev-parse origin/main

# if the stamp is null (locally built image, or a pre-ELEG-110 pull) — check the
# image digest instead
docker inspect elegoo-web --format '{{.Image}}'
docker buildx imagetools inspect ghcr.io/runnane/elegoo-web:latest

# deploy (pull first, always — see the 6.7-min-vs-10-s measurement above)
sudo docker compose -f /opt/elegooweb/compose.yml pull
sudo docker compose -f /opt/elegooweb/compose.yml up -d

# stop only (does not remove data/.cache/.env, which are bind-mounted, not in the
# container)
sudo docker compose -f /opt/elegooweb/compose.yml stop
```

**Verify at the receiver, not at the exit code** — a successful `docker compose up -d`
proves the recreate happened, not that the new process is healthy:

```bash
curl -s localhost:8088/api/health | jq .          # {"ok":true,"mqtt":"connected","mqttPhase":"connected","build":{…}}
docker inspect elegoo-web --format '{{.State.StartedAt}}'   # did it actually restart?
docker logs elegoo-web --tail 30                             # startup banner: build, printer, ports, AI/Telegram state
```

Two fields in there carry the whole check:

- **`build.commit`** answers "is my change live?" for a CI-built image — compare it
  against the commit you expect (`git rev-parse origin/main`). Equal means the pull
  landed; null means an unstamped image — locally built, or a pre-ELEG-110 pull
  (fall back to the digest compare above); anything else means the pull has not
  happened yet.
- **`mqtt":"connected"`** is the one that matters for whether it *works*: the process can
  start happily and fail to reach the printer, and the web UI then looks fine and shows
  nothing.

  **If it is not `connected`, read `mqttPhase` before blaming the deploy** (ELEG-59). The
  coarse field collapses two unrelated failures into `broker_only`, and the instinct
  after a deploy is to roll back — which on 2026-08-08 was the wrong move, because the
  service was fine and the printer's firmware had hung:

  | `mqttPhase` | What it means | Who fixes it |
  | --- | --- | --- |
  | `awaiting_sn` | The broker answered but the printer has never published. Registration was **never attempted**, so `mqttRegisterAttempts` is 0. The machine's Linux side is up; its control application is not. | Power-cycle the **printer**. Not a deploy problem. |
  | `registering` | An SN is known and registration is in flight. Watch `mqttRegisterAttempts` climb. | Wait; if it keeps climbing, the printer is not answering. |
  | `rejected` | The printer already has its maximum of two clients. | Close another client — the vendor app, or a second copy of this service. |

  `mqttMessage` carries the same thing as one sentence, which is usually all you need:

  ```bash
  curl -s localhost:8088/api/health | jq -r '.mqttPhase, .mqttRegisterAttempts, .mqttMessage'
  ```

## Rollback (while `/opt/elegooweb/src` still exists)

The systemd unit file and `/opt/elegooweb/src` are deliberately still on disk — confirmed
present 2026-09-16 — so a rollback to the pre-compose deploy is one command pair, not a
rebuild:

```bash
sudo docker compose -f /opt/elegooweb/compose.yml down
sudo systemctl enable --now elegooweb
```

This is a rollback of *mechanism*, not of code — the systemd unit runs whatever is in
`/opt/elegooweb/src` at the time, which was last written by an `install.sh` run and may
be behind whatever the container had. Once an operator has run the cleanup step from
ELEG-108 (removing `src/`, `dist/`, `node_modules/` etc. from `/opt/elegooweb`), this
rollback path stops existing — check `/opt/elegooweb/src` is actually there before
promising it as a fallback in an `OPERATOR:` issue.

## What this means for the tracker

ELEG has `tracksProduction` **on**, so `IN_PRODUCTION` exists and is meaningful:

- A merged PR moves the issue to `MERGED` and changes **nothing that is running** — a
  compose pull is a separate, later step, exactly as an `install.sh` run used to be.
- `IN_PRODUCTION` means the pull + recreate happened and `/api/health` answered from the
  new code. That is operator work — file it as its own `OPERATOR:` issue rather than
  leaving a code issue open across a manual step, give the exact commands above, and
  ask for the output. **The evidence is `build.commit` from `/api/health` matching the
  commit that was deployed** (or the image digest, when the stamp is null) — not a
  successful `docker compose up -d` exit code.
- The status automation never moves an issue backwards out of `MERGED` /
  `IN_PRODUCTION`, so setting `IN_PRODUCTION` optimistically is not correctable later.
  Set it after the verification, from the output you were given.
- **The moving part is now an image digest, not a commit rsynced by hand** — CI publishes
  it, an operator pulls it, and nothing in between reads `git`. If watchtower is ever
  pointed at the `elegoo-web` container (it currently does not — see ELEG-108), every
  merge to `main` becomes a self-deploy and
  `IN_PRODUCTION` stops being something an operator verifies and starts being something
  that happens on a timer whether or not anyone checked `/api/health`. That would need
  its own decision about what the status is still supposed to mean, not an assumption
  that today's manual-verification model still holds.
