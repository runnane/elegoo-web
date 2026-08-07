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
2. **`Access-Control-Allow-Origin: *`** is set on `/mcp`, `/octoprint/*` and
   `/moonraker/*`. With no credentials to withhold, that means **any web page a browser
   visits can issue those requests** from inside the network the browser is on. A
   `SameSite` cookie does not help, because there is no cookie.
3. **The compat layers advertise auth they do not have.** `octoprint-compat.ts` returns
   a fixed `apikey: 'elegoo-cc2-compat'` and the Moonraker layer answers
   `access.get_api_key` — so a client shows "connected, authenticated" while nothing was
   ever checked. Do not read those endpoints as evidence that an auth path exists.

**Rule:** never add an endpoint on the assumption that only the LAN can reach it, and
never add one that widens the write surface without saying so on the issue. Adding an
authentication layer is a *feature* someone has to decide on — file it, don't smuggle it
in, and don't design new endpoints as though it were already there.

## The camera and the print data are not neutral either

`/api/snapshot`, `/api/stream` and the Telegram `/photo` command return a **live image
of a room**. The report PDFs under `${DATA_DIR}/reports`, the gcode cache and the debug
captures are all served over the same unauthenticated API. Treat all of it as personal
data under the org policy: it is a camera in someone's home or workshop, so an endpoint
that exposes it more widely, or a fixture that commits one of those images, is not a
detail.

**The Telegram bot has no sender check.** `src/telegram/commands.ts` registers
`/start`, `/help`, `/status` and `/photo` with no filter on who sent them, so **any**
Telegram user who finds the bot gets printer status and a camera photo. Outbound
notifications go only to the configured `TELEGRAM_CHAT_ID`; inbound is open. If you
touch that file, the sender gate is the first thing to add (compare a numeric id, never
a handle — handles are re-assignable), and gate on it *before* the handler does any
work.

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
