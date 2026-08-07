# Deployment — and why `MERGED` is not `IN_PRODUCTION`

Production for this repo runs **on the same machine you develop on**. That is the single
most important thing on this page: your checkout and `/opt/elegooweb` (the live service)
are different trees that can silently disagree.

## What is actually running

| | |
| --- | --- |
| unit | `elegooweb.service` (`/etc/systemd/system/elegooweb.service`, `enabled`) |
| user | `elegooweb` (system user, no home, no shell) |
| working dir | **`/opt/elegooweb` — not a git checkout.** `git -C /opt/elegooweb status` fails |
| exec | `/usr/bin/node --import tsx src/server/index.ts` — the **TypeScript is run directly**, so `src/**` in that directory *is* the production code |
| env | `EnvironmentFile=/opt/elegooweb/.env` (separate from the checkout's `.env`) |
| ports | `SERVICE_PORT` 8088 (web + API + `/ws` + `/mcp`), `MOONRAKER_PORT` 7125 |
| hardening | `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp`, `ReadWritePaths=/opt/elegooweb` |
| restart | `Restart=always`, `RestartSec=5` |

Because the service runs the TypeScript directly, **there is no build step for the
backend** — copying a `.ts` file into `/opt/elegooweb/src/server/` and restarting is a
deploy. The frontend *does* need `vite build`, and the service serves the resulting
`dist/` (with SPA fallback) from that same directory.

There is also a Docker path (`ghcr.io/runnane/elegoo-web`, `Dockerfile`,
`docker-compose.example.yml`) — it is real and released, but it is **not** what runs
here. Don't reason about this host's behaviour from the compose file.

## How a deploy happens

`contrib/install.sh` (`sudo pnpm service:install`) is the mechanism: it creates the
user and the directory, then **`rsync -a --delete`** of `src/`, `dist/` and `public/`
(one directory at a time) plus a plain copy of `package.json`, `pnpm-lock.yaml` and the
tsconfigs, writes the build stamp, `pnpm install --prod`,
`chown -R elegooweb:elegooweb`, install the unit, `systemctl enable` + restart. It
preserves an existing `.env`, and **requires `rsync`** — it exits rather than falling
back to a copy that cannot delete.

Three consequences that have already produced a real artefact:

1. **The copy is delete-consistent, but only from the next install onwards.** It used to
   be `cp -r`, which never deletes, so a file removed from git stayed in production
   forever. `src/`, `dist/` and `public/` are now `rsync -a --delete`, **scoped one
   directory at a time** — never a sweep over `$INSTALL_DIR`, because `.env`, `data/` and
   `node_modules/` live at the install root beside them and must survive. The
   `--exclude`s in the installer are a second layer, not the defence.

   What that backlog looks like today, from a dry run against the live directory:
   `/opt/elegooweb/src/ui/bed-mesh.ts` (deleted from the repo by `a8157a9`) plus **24
   orphaned hashed bundles in `dist/assets/`**, one pair per build ever deployed. All
   unreferenced, so harmless — but the same mechanism would just as happily keep serving
   a retired route or a module something still imports. Until an install actually runs
   they are all still there, so **verify a removal with `ls`, not with the git diff.**
2. **The deployed tree still has no git metadata — but it does carry a stamp.** The
   installer writes `/opt/elegooweb/build-info.json` (commit, short commit,
   `git describe`, `package.json` version, install timestamp) and the service reports it
   from `/api/health` as `build`, read once at startup. So "is this change live?" is now
   one request, answered at the receiver:
   ```bash
   curl -s localhost:8088/api/health | jq .build
   # {"commit":"a8157a9…","shortCommit":"a8157a9","describe":"v1.4.0-3-ga8157a9",…}
   ```
   **All-null `build` means unstamped, not broken** — a `pnpm dev` run, or a deploy made
   before ELEG-10 landed. Nothing else distinguishes the two; the first stamped install
   is what fixes that. The old hand-diff still works and is the only check that catches a
   *stale* file rather than an old one:
   ```bash
   diff -rq --exclude=node_modules --exclude=data --exclude=.env --exclude=dist \
     "$PWD/src" /opt/elegooweb/src
   ```
   The stamp lives at the install root, deliberately outside `src/`, `dist/` and
   `public/`, so a delete-consistent copy of those directories cannot remove it.
3. **`.env` divergence is invisible.** The production `.env` is a *different file* from
   the one you test with, and the installer only ever creates it. A new
   `config.ts` key therefore defaults silently in production until someone adds it
   there — which makes "add the key to `/opt/elegooweb/.env`" part of the deploy, not
   an afterthought.

## Exposure is decided outside this repo

The service binds `0.0.0.0` and has **no authentication of any kind** (see
[security.md](security.md)), so what limits who can reach it is entirely the network
around it: a reverse-proxy vhost and DNS, both configured in the **`~/ansible` (ANS)**
repo rather than here. A change to *who can reach it* is therefore an ANS issue, and the
specifics for a given deployment belong in the **ELEG tracker**, deliberately not in this
public repository.

Two consequences for anyone testing this:

- **A request from the host itself proves nothing about reachability.** `curl` and any
  local fetch tool resolve and route from inside the network, so a `200` says only that
  the service is up — not that anyone else can get to it. Answering "is this exposed?"
  needs a resolver check (what does public DNS return — a routable address or an RFC1918
  one?) and, for reachability, a client genuinely off the network.
- **The proxy is not the only door.** Because the bind is `0.0.0.0`, ports 8088 and 7125
  are directly reachable from anything routed to the host, bypassing whatever vhost or
  auth the proxy might add.

Read [security.md](security.md) before adding an endpoint: what protects this service is
network position, not code.

## Operator commands

These are the ones worth pasting into an `OPERATOR:` issue. All of them are for a
human on this host; an agent may read (`status`, `journalctl`, `diff`) but does not
restart the service or copy files into `/opt`.

```bash
# what is running, and since when
systemctl status elegooweb --no-pager
journalctl -u elegooweb -n 100 --no-pager        # or: pnpm service:logs

# is production the same code as the checkout?
diff -rq --exclude=node_modules --exclude=data --exclude=.env --exclude=dist \
  "$PWD/src" /opt/elegooweb/src

# what would the deploy DELETE? read this before every install — it is the safety case
for d in src dist public; do
  rsync -n -v -a --delete --exclude=.env --exclude=data/ --exclude=node_modules/ \
    "$PWD/$d/" "/opt/elegooweb/$d/" | grep '^deleting' || true
done
# -n writes nothing. The list must contain only files you meant to remove, and must
# never mention .env, data/ or node_modules/ — if it does, stop and do not install.

# deploy (from a clean, merged checkout on main)
git switch main && git pull --ff-only
pnpm install && pnpm gates && pnpm build        # dist/ must be current
sudo pnpm service:install                       # rsync --delete + install --prod + restart

# restart / stop only
sudo systemctl restart elegooweb
sudo systemctl stop elegooweb
```

**Verify at the receiver, not at the exit code** — a successful `cp` proves nothing:

```bash
curl -s localhost:8088/api/health | jq .          # {"ok":true,"mqtt":"connected","build":{…}}
systemctl show -p ActiveEnterTimestamp elegooweb  # did it actually restart?
journalctl -u elegooweb -n 30 --no-pager          # startup banner: build, printer, ports, AI/Telegram state
```

Two fields in there carry the whole check:

- **`build.commit`** answers "is my change live?". Compare it against the commit you
  deployed — `git rev-parse HEAD` in the checkout you installed from. Equal means the
  copy landed; anything else means it did not, whatever the `cp` exit code said. All
  nulls means the install predates the stamp (or was not run from a checkout).
- **`mqtt":"connected"`** is the one that matters for whether it *works*: the process can
  start happily and fail to reach the printer, and the web UI then looks fine and shows
  nothing.

## What this means for the tracker

ELEG has `tracksProduction` **on**, so `IN_PRODUCTION` exists and is meaningful:

- A merged PR moves the issue to `MERGED` and changes **nothing that is running**.
- `IN_PRODUCTION` means the copy + restart happened and `/api/health` answered from the
  new code. That is operator work — file it as its own `OPERATOR:` issue rather than
  leaving a code issue open across a manual step, give the exact commands above, and
  ask for the output. **The evidence is `build.commit` from `/api/health` matching the
  commit that was deployed**, not a successful `sudo pnpm service:install` — set the
  status from that output rather than from the install having exited 0.
- The status automation never moves an issue backwards out of `MERGED` /
  `IN_PRODUCTION`, so setting `IN_PRODUCTION` optimistically is not correctable later.
  Set it after the verification, from the output you were given.
