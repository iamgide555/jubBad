/**
 * One consistent read of everything a bill or a checkout quote is priced
 * from: session, roster, effective bill config, finished games with their
 * recorded shuttle uses, and the settlement ledger. Preview, settle and the
 * final bill all load through here (inside one transaction), so none of them
 * can combine mismatched versions of config, uses and receipts.
 */
import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DEFAULT_BILL_CONFIG, type BillConfig, type BillMatch } from '../../../engines/bill.ts';
import { parseBillConfig, sanitizeForRoster, withoutPerPerson } from './bill-config.js';
import { teamPlayers } from './pairing-teams.js';

export type BillSnapshot = Awaited<ReturnType<typeof loadBillSnapshot>>;

export async function loadBillSnapshot(tx: Prisma.TransactionClient, code: string) {
  const session = await tx.session.findUnique({
    where: { code },
    include: { roster: { include: { player: { select: { name: true } } } } },
  });
  if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });
  // Prefill from the newest earlier config this session may use: an ordinary
  // session never inherits an advanced session's perShuttle model, so the
  // search walks back past those rather than stopping at the latest.
  const earlier = session.billConfig
    ? []
    : await tx.session.findMany({
        where: { groupId: session.groupId, code: { not: code }, billConfig: { not: null }, createdAt: { lt: session.createdAt } },
        orderBy: { createdAt: 'desc' },
        select: { billConfig: true },
      });
  const previous =
    earlier.find((e) => session.shuttleToolsEnabled || parseBillConfig(e.billConfig)?.model !== 'perShuttle') ?? null;
  const [pairings, openPairings] = await Promise.all([
    tx.pairing.findMany({
      where: { sessionId: code, confirmedAt: { not: null }, endedAt: { not: null } },
      orderBy: [{ courtNumber: 'asc' }, { matchNumber: 'asc' }],
    }),
    tx.pairing.findMany({ where: { sessionId: code, endedAt: null } }),
  ]);
  const [identities, uses, checkouts] = session.shuttleToolsEnabled
    ? await Promise.all([
        tx.sessionShuttle.findMany({ where: { sessionId: code } }),
        tx.pairingShuttleUse.findMany({ where: { pairing: { sessionId: code } } }),
        tx.sessionCheckout.findMany({ where: { sessionId: code }, orderBy: { settledAt: 'asc' } }),
      ])
    : [[], [], []];

  let config = parseBillConfig(session.billConfig);
  let configSource: 'saved' | 'previous' | 'default' = 'saved';
  if (config === null) {
    const prev = parseBillConfig(previous?.billConfig ?? null);
    config = prev ? withoutPerPerson(prev) : DEFAULT_BILL_CONFIG;
    configSource = prev ? 'previous' : 'default';
  }
  config = sanitizeForRoster(config, session.roster.map((r) => r.playerId));
  return { session, config, configSource, pairings, openPairings, identities, uses, checkouts };
}

/** Engine ids are opaque; zero-padded numbers sort in shuttle-number order so remainders follow numbering. */
export function shuttleKeys(identities: readonly { id: string; number: number }[]): Map<string, string> {
  return new Map(identities.map((sh) => [sh.id, `n${String(sh.number).padStart(6, '0')}`]));
}

/** The finished games as the bill engine wants them; advanced sessions carry their recorded shuttle ids. */
export function engineMatches(snapshot: BillSnapshot): BillMatch[] {
  const { session, pairings, identities, uses } = snapshot;
  const keyOf = shuttleKeys(identities);
  const usesByPairing = new Map<string, string[]>();
  for (const u of uses) usesByPairing.set(u.pairingId, [...(usesByPairing.get(u.pairingId) ?? []), u.shuttleId]);
  return pairings.map((p) => ({
    players: teamPlayers(p),
    ...(session.shuttleToolsEnabled
      ? {
          shuttleIds: p.shuttleLogKnown
            ? (usesByPairing.get(p.id) ?? []).map((id) => keyOf.get(id) ?? id).sort()
            : null,
        }
      : {}),
  }));
}

export type { BillConfig };
