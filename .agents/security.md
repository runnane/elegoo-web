# Security

Start from the accurate statement, because every design decision here follows from it:

> **The service has no authentication.** Not a password, not an API key, not a session.
> Every REST endpoint, the WebSocket, `/mcp`, the Moonraker layer and the OctoPrint
> layer answer any request that reaches the port.

That is not a bug report, it is the current design — the service was written for a
trusted LAN. It becomes a serious problem the moment the port is reachable from
somewhere else, and **whether it is, is decided outside this repo** (a proxy or tunnel
configured in the `~/ansible` repo; the specifics for a given deployment belong in the
tracker, not in this public repository).

## What an unauthenticated request can do

Not just read. The control surface is complete:

| Surface | Reachable without credentials | Includes |
| --- | --- | --- |
| `POST /mcp` | yes | `set_temperature`, `fan`, `led`, `home`, `move`, `start_print`, `pause_print`, `resume_print`, `stop_print`, **`emergency_stop`** |
| `/api/*` | yes | printer commands, file upload, camera snapshot/stream, print reports |
| `/moonraker/*` and the dedicated `:7125` server | yes | the same class of control, in Moonraker's vocabulary |
| `/octoprint/*` | yes | OctoPrint's job + control endpoints |
| `/ws` | yes | live state, and command frames |

Three things make this sharper than a typical "no auth" note:

1. **The consequences are physical.** A request can heat a nozzle, drive the toolhead,
   start a job or abort a 14-hour print. There is no undo.
2. **`Access-Control-Allow-Origin: *` — fixed in ELEG-24, and worth understanding anyway.**
   It used to be set on **five** surfaces: `/mcp`, `/octoprint/*`, `/moonraker/*`, and the
   two the original note missed — **`/api/*`** (the snapshot, stream and control routes)
   and **the dedicated `:7125` server**. With no credentials to withhold, that meant **any
   web page a browser visits could issue those requests** from inside the network the
   browser is on. A `SameSite` cookie does not help, because there is no cookie.

   This is the one that survived a LAN-only deployment intact, and it is easy to
   under-rate: the attacker does not need to reach the network, only to get someone who is
   already on it to load a page. "It is not exposed" is an answer about inbound routing,
   not about this.

   The default is now **same-origin** — no `Access-Control-Allow-Origin` at all unless
   `CORS_ALLOWED_ORIGINS` names one. The SPA is served by the origin it calls, so it needs
   none. A browser-based compat client on another origin (Mainsail, Fluidd) now needs that
   variable set; `*` still works as an explicit opt-in, which is the point — the dangerous
   setting should be something a person chose.

   All five surfaces go through `src/server/cors.ts`. **Add a new surface and you get the
   policy for free only if you route through it** — the `:7125` server is the cautionary
   example: it sets the headers once in `handleHttp` precisely because ~100
   `jsonResult`/`jsonError` call sites could each have forgotten.
3. **The compat layers advertise auth they do not have.** `octoprint-compat.ts` returns
   a fixed `apikey: 'elegoo-cc2-compat'` and the Moonraker layer answers
   `access.get_api_key` — so a client shows "connected, authenticated" while nothing was
   ever checked. Do not read those endpoints as evidence that an auth path exists.

**Rule:** never add an endpoint on the assumption that only the LAN can reach it, and
never add one that widens the write surface without saying so on the issue. Adding an
authentication layer is a *feature* someone has to decide on — file it, don't smuggle it
in, and don't design new endpoints as though it were already there.

**And before claiming this service is or is not exposed, measure it properly.** A `curl`
from the host resolves and routes from inside the network, so a `200` proves the service is
up and nothing else — that mistake was made while writing these docs (2026-08-07) and
produced two URGENT issues on a false premise. The honest check is: what does a *public*
resolver return for the name (a routable address, or an RFC1918 one?), and does a client
genuinely off the network reach it? See [deployment.md](deployment.md).

## The camera and the print data are not neutral either

`/api/snapshot`, `/api/stream` and the Telegram `/photo` command return a **live image
of a room**. The report PDFs under `${DATA_DIR}/reports`, the gcode cache and the debug
captures are all served over the same unauthenticated API. Treat all of it as personal
data under the org policy: it is a camera in someone's home or workshop, so an endpoint
that exposes it more widely, or a fixture that commits one of those images, is not a
detail.

**The Telegram bot's inbound commands are gated on the sender — keep it that way.**
`/start`, `/help`, `/status` and `/photo` once registered with no filter on who sent
them, so **any** Telegram user who found the bot got printer status and a camera photo;
outbound went only to `TELEGRAM_CHAT_ID`, but inbound was open. ELEG-3 closed it:
`src/server/allowlist.ts` holds the decision (pure, and the one part of the bot a test
reaches — `src/server/__tests__/telegram-allowlist.test.ts`), and
`src/server/telegram.ts` gates on it *before* the handler does any work. Two properties
are load-bearing: ids are compared as **numeric ids, never handles** (handles are
re-assignable), and an **empty allowlist denies everyone** rather than allowing all — a
missing env var must not reopen the hole. Any new command goes behind the same gate.

That fix had to be written twice, because an unreachable second copy of the bot lived
under `src/telegram/`. It is deleted (ELEG-23), so there is now exactly one place to
get this right.

## Secrets

- `PRINTER_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `AI_VLM_API_KEY` come from the environment
  (`.env`, gitignored) via `src/server/config.ts`. Read them at runtime through that
  config object — never hardcode one, never send one to the browser, never log one.
  `logger.ts` writes to `${DATA_DIR}/logs`; an `AI_VLM_API_KEY` in a debug line is a
  credential on disk and, given the above, a credential behind an unauthenticated
  endpoint.
- **Committed files carry placeholders only** — `.env.example`,
  `docker-compose.example.yml`, `contrib/install.sh`'s generated default `.env`, any
  fixture. This repo is **public**: a committed secret is published, and rotating it is
  the only remedy.
- **There are two `.env` files** on a host that runs the service locally: the
  checkout's and production's. Neither is in git; see
  [deployment.md](deployment.md).
- **Environment-specific hostnames are the same category, and are easier to miss than a
  secret.** `vite.config.ts`'s `server.allowedHosts` hardcoded a deployment hostname and
  a private RFC1918 address for the life of the repo (ELEG-82). Neither is a credential,
  which is exactly why nobody looked twice — but a hostname naming the production
  deployment plus an internal addressing scheme is *"infrastructure detail that could aid
  an attacker"*, and it sat in a **public** repo. They now come from
  `VITE_ALLOWED_HOSTS` in the gitignored `.env`, defaulting to `localhost`.

  Two things worth carrying forward. First, **dev-only config still gets committed** —
  `server.*` never reaches production, so it reads as harmless and escapes the review
  that a runtime setting would get. Second, **the values remain in git history and that
  is a deliberate accepted decision, not an oversight**: rewriting published history is
  disruptive and out of proportion for a public DNS name and an unreachable LAN address.
  Do not re-file it. If a genuine *secret* ever lands here, the calculus is different and
  rotation — not a rewrite — is the remedy, as above.
- Org data-protection policy applies to everything an agent writes, not just code: no
  real credentials, no personal data, no internal network detail in issue comments, PR
  bodies, commit messages or committed docs. Use placeholders, and redact before pasting
  any command output into the tracker.

## Input validation, such as it is

`config.ts` validates `PRINTER_IP` and the ports at boot and throws — that is the only
systematic validation in the service. Route handlers in `rest-api.ts` parse their own
input ad hoc.

So when you add a handler: validate its input in the handler (`zod` is already a
dependency and is the right tool), reject rather than coerce, and **never interpolate
request input into a path** — `/api/files/*`, `/api/reports/*` and
`/api/debug/captures/*` all map a request string onto the filesystem, which is the place
a traversal bug will appear. Decode once, then check the resolved path is inside the
directory you meant.

## What to do when you find something here

Findings about *this deployment* — what is exposed, from where, and what answered —
belong in the **ELEG tracker** (the portal is private), labelled `bug` + the relevant
area, with a priority that reflects that the device is physical. What belongs in this
public repo is the *shape* of the problem and the rule that prevents the next one, which
is what this page is.
