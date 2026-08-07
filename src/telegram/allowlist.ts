/**
 * Who is allowed to talk to the bot (ELEG-3).
 *
 * Both Telegram entry points — `src/server/telegram.ts`, which is what the service runs,
 * and the standalone `src/telegram/bot.ts` — registered `/start`, `/help`, `/status` and
 * `/photo` with **no check on the sender**. `TELEGRAM_CHAT_ID` was only ever used for
 * *outbound* messages, so inbound was open to anyone who found the bot: printer status,
 * and via `/photo` a live camera image of the room.
 *
 * Kept here, pure and separate from grammy, so the boundary is unit-testable without a
 * Telegram connection — see `src/server/__tests__/telegram-allowlist.test.ts`.
 */

/**
 * Parse a comma-separated allowlist of numeric Telegram ids.
 *
 * Ids are matched as **strings** deliberately: Telegram ids can exceed
 * `Number.MAX_SAFE_INTEGER`, and a channel id is negative. Anything that is not a
 * well-formed id is dropped rather than silently widening the gate — a typo should cost
 * you access, not hand it out.
 */
export function parseAllowedChatIds(raw: string | undefined, fallback = ''): string[] {
  const source = raw?.trim() ? raw : fallback;
  if (!source) return [];
  return [
    ...new Set(
      source
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^-?\d+$/.test(s)),
    ),
  ];
}

/**
 * Is this sender allowed?
 *
 * **An empty allowlist denies everyone.** That is the safe direction and it costs
 * nothing: `telegramEnabled` already requires `TELEGRAM_CHAT_ID` to be set, so a
 * correctly-configured bot always has at least one id. Treating empty as "allow all"
 * would turn a missing variable back into the hole this closes.
 */
export function isAllowedSender(allowed: readonly string[], fromId: number | undefined): boolean {
  if (fromId == null) return false;
  return allowed.includes(String(fromId));
}
