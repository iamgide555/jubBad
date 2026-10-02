# ตามลูกแบด: charge each player in full per shuttle

## Intent and scope

Today ตามลูกแบด (`perShuttle`) splits the **recorded shuttle cost**: every
distinct shuttle's price is shared across the games that used it, then across
each game's players. A host who wants a simple per-head rule ("20 baht a
shuttle, you pay for the shuttles you played with") cannot get it, and has to
leave the bill page to set the shuttle price on the summary page.

Add, **inside ตามลูกแบด** (not a new model), a switch:

- **แชร์ตามต้นทุน** (`shared`, the default and today's behavior), and
- **คิดเต็มต่อคน** (`full`): a player pays
  `startingFee + (distinct shuttles in their finished games x charge) + hostFee`,
  rounded up to the rounding step, plus the walk-in adjustment as today.

And put the two shuttle fields (physical count, price per shuttle) on the bill
page, so the host never has to go back to the summary page for them.

Success: the host enters a charge per player per shuttle, sees every player's
amount follow the shuttles they actually touched, and the margin line still
compares collected money with the real shuttle cost.

Out of scope: a per-player-per-game count (a shuttle a player touched twice
counts once, owner decision), new routes, a database migration, changing the
`fair`, `perGame` or `buffet` models.

## Decisions and why

- **A switch inside ตามลูกแบด, not a fifth model.** Owner decision. It keeps one
  place for "price by recorded shuttles", reuses the starting fee, and leaves the
  model list, the early-checkout model list and every saved bill untouched.
- **Two numbers: the real shuttle price and a separate charge.** In `full`, every
  player in a doubles game pays the whole charge, so the host collects about four
  times the shuttle cost when charge equals price. Using one number for both would
  make the host-only margin meaningless. The real price (`Session.shuttlePriceSatang`)
  stays the cost, used for the margin and for `shared`. The charge
  (`BillConfig.perPlayerShuttleSatang`) is what a player pays per shuttle. **Blank
  charge (`null`) follows the shuttle price** (owner decision: the shuttle price is
  the default), so the common case needs one number.
- **Distinct shuttles per player.** A shuttle reused in two games the same player
  played is charged once to that player. Matches the numbered-shuttle rule that a
  reused shuttle is one shuttle.
- **`full` is rate-based, like per-game and buffet.** Nothing is derived from a
  total, so an early checkout freezes only the leaver's amount and never changes
  anyone else's. The settled-credit residual logic (which exists to keep a
  *cost* covered) applies to `shared` only.
- **Margin is unchanged:** collected minus (court fee + physical shuttle count x
  real price). That is why the count and price fields belong on the bill page.
- **Unknown shuttle use still blocks.** A finished game of that player with no
  recorded shuttle info yields the existing `UNKNOWN_SHUTTLE_USE` warning on the
  bill and blocks that player's early checkout. A charge that resolves to nothing
  (no charge and no shuttle price) while shuttles were used yields
  `MISSING_SHUTTLE_PRICE`.

## Data model

No migration. `Session.billConfig` is a JSON column parsed only by
`server/src/sessions/bill-config.ts`, tolerant on read. `BillConfig` gains:

- `shuttleCharge: 'shared' | 'full'`, default `'shared'`;
- `perPlayerShuttleSatang: number | null`, default `null` (follow the shuttle price).

Every bill saved before this reads as `shared` / `null`, so no existing bill
changes by a satang.

## Engine rules (`engines/bill.ts`, `engines/checkout.ts`)

Let `charge = config.perPlayerShuttleSatang ?? shuttlePriceSatang` and, for a
player, `touched = number of distinct shuttle ids across their finished games`.

- `computeBill`, `perShuttle` + `full`: each due player's shuttle line is
  `touched x charge` (0 when `charge` is `null`, with `MISSING_SHUTTLE_PRICE` if
  any shuttle was recorded). `costModel` is false for this case, so settled
  receipts stay frozen and the residual/credit logic does not run; the walk-in
  carry-over behaves exactly as for `perGame`.
- `computeCheckoutPreview`, model `perShuttle` + `full`: `shuttleSatang = touched
  x charge`; blocked with `UNKNOWN_SHUTTLE_USE` / `MISSING_SHUTTLE_PRICE` exactly
  where `shared` is today.
- `shared` is byte-for-byte what it is now.
- `validate` rejects an unknown `shuttleCharge` and a negative or fractional
  `perPlayerShuttleSatang` (the engine fails loudly on bad input).

## API

- `POST /sessions/:code/bill-config` accepts the two new fields (the DTO
  whitelist would otherwise silently drop them). Both are optional on input
  for old clients: absent means `shared` / `null`.
- The early-checkout quote response gains `shuttleCharge` and `chargeSatang`
  (the resolved charge, or `null`) so the dialog can say which basis priced it.
- The bill page saves count and price through the existing
  `POST /sessions/:code/shuttle-details` (owner-only, allowed after the session
  ended, partial updates). No new route.

## Web

- **Bill page:** a "ลูกแบด" block at the top of the settings card with the
  physical count and price per shuttle (shown in every model, since the margin
  uses them); each edit sends only the changed field to `shuttle-details`, then
  re-reads the bill. Blank count keeps today's meaning (derived from the games
  when the log is complete).
- Inside ตามลูกแบด: a two-button switch under the starting-fee row; `full` reveals
  "ค่าลูกต่อคนต่อลูก (บาท)" with the shuttle price as its placeholder. The hint
  text follows the switch; the "set the price on the summary page" link is gone.
- **LINE text:** `full` prints `ค่าเริ่มต้น X฿/คน + ค่าลูก Y฿ ต่อลูกที่เล่น`;
  `shared` text unchanged. The margin is never printed.
- **Early-checkout dialog:** a short basis label (for example
  "คิดเต็มต่อคน - 20฿/ลูก") so the host can see why a quote differs. The dialog
  has no switch of its own.
- Thai first, English added to `messages.en.xlf` by hand; no interpolation inside
  translatable strings.

## Testing

- Engine: the owner's example (a player in two games on three distinct shuttles
  pays 3 x charge); a shuttle reused across one player's games counts once; blank
  charge falls back to the shuttle price; an explicit charge overrides it;
  `UNKNOWN_SHUTTLE_USE` and `MISSING_SHUTTLE_PRICE`; an early leaver in `full`
  does not change anyone else's amount; the margin uses the real price; `shared`
  results are unchanged; `validate` rejects bad values.
- Server: config round-trip and legacy configs read as `shared`/`null`; the
  bill-config route accepts, returns and rejects bad values for both fields; an
  old client omitting them still saves; the quote carries the basis and matches
  the engine; a charge change makes an old quote stale.
- Web: the switch, the charge placeholder and override, count and price saving
  through `shuttle-details`, the LINE text, the dialog label.
- A 50-player run with `full` selected, comparing every amount with the engine.

## Docs

Update the Bill section of `docs/overview.md`: the ตามลูกแบด switch, why the
charge is separate from the real price (so the margin stays honest), and why
`full` is rate-based (nobody else's amount moves when someone checks out).
