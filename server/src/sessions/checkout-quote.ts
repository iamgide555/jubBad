/**
 * Prices one early checkout from a BillSnapshot and fingerprints every input
 * that fed the price. Used by preview (read-only) and again inside the settle
 * transaction, so a confirmation is always judged against what the database
 * says NOW, never against a client-supplied amount.
 */
import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { CheckoutModel } from '../../../engines/bill.ts';
import { CheckoutBlockedError, computeCheckoutPreview, type CheckoutPreview } from '../../../engines/checkout.ts';
import { engineMatches, type BillSnapshot } from './bill-snapshot.js';
import { activeCheckouts, parseCheckoutBreakdown } from './checkout-pricing.js';
import { teamPlayers } from './pairing-teams.js';

export interface CheckoutQuote extends CheckoutPreview {
  playerId: string;
  snapshotHash: string;
  /** Engine ids of the distinct shuttles this player's finished games used. */
  shuttleIds: string[];
  shuttlePriceSatang: number | null;
  walkIn: boolean;
}

/** JSON with sorted keys, so the same inputs always hash the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function quoteCheckout(snapshot: BillSnapshot, playerId: string, model: CheckoutModel): CheckoutQuote {
  const { session, config, pairings, openPairings, checkouts } = snapshot;
  if (!session.shuttleToolsEnabled) throw new BadRequestException({ code: 'CHECKOUT_DISABLED' });
  if (session.endedAt !== null) throw new ConflictException({ code: 'SESSION_ENDED' });
  const row = session.roster.find((r) => r.playerId === playerId);
  if (!row) throw new NotFoundException({ code: 'PLAYER_NOT_ON_ROSTER' });
  const settled = activeCheckouts(checkouts);
  if (settled.has(playerId)) throw new ConflictException({ code: 'PLAYER_CHECKED_OUT' });
  // A pending lineup is never edited under the host's hand, and a running game
  // must finish first: both have to be cleared before anyone can be settled.
  const onCourt = openPairings.find((p) => teamPlayers(p).includes(playerId));
  if (onCourt) throw new ConflictException({ code: 'PLAYER_ON_COURT', courtNumber: onCourt.courtNumber });

  const matches = engineMatches(snapshot);
  const walkInIds = session.roster.filter((r) => r.walkIn).map((r) => r.playerId);
  const otherSettled = checkouts
    .filter((c) => c.undoneAt === null && c.playerId !== playerId)
    .map((c) => {
      const b = parseCheckoutBreakdown(c.breakdown);
      return { playerId: c.playerId, amountSatang: c.amountSatang, walkInFeeSatang: b.walkInFeeSatang, walkInDiscountSatang: b.discountSatang };
    });
  let preview: CheckoutPreview;
  try {
    preview = computeCheckoutPreview({
      playerId, model, config, matches, shuttlePriceSatang: session.shuttlePriceSatang, walkInIds, otherSettled,
    });
  } catch (e) {
    if (e instanceof CheckoutBlockedError) throw new ConflictException({ code: e.code });
    throw e;
  }

  const ownGames = matches.filter((m) => m.players.includes(playerId));
  const shuttleIds = [...new Set(ownGames.flatMap((m) => m.shuttleIds ?? []))].sort();
  const snapshotHash = createHash('sha256')
    .update(
      stable({
        v: 1,
        model,
        playerId,
        config,
        price: session.shuttlePriceSatang,
        walkIns: [...walkInIds].sort(),
        games: pairings.map((p, i) => ({ id: p.id, revision: p.revision, players: matches[i].players, shuttles: matches[i].shuttleIds ?? null })),
        settled: checkouts.filter((c) => c.undoneAt === null).map((c) => ({ id: c.id, playerId: c.playerId, amountSatang: c.amountSatang })),
      })
    )
    .digest('hex');
  return { ...preview, playerId, snapshotHash, shuttleIds, shuttlePriceSatang: session.shuttlePriceSatang, walkIn: row.walkIn };
}
