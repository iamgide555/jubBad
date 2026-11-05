import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LineAccountsService } from '../../line/line-accounts.service.js';
import { lineConfig } from '../../line/line-config.js';
import { cardDate } from '../../line/line-summary-card.js';
import { planAtLeast } from '../../plans/plan.js';
import { PlansService } from '../../plans/plans.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CollectorService } from '../collector.service.js';
import { parsePayAccount, serializePayAccount, validatePayAccount } from '../pay-account.js';
import { PaymentCardService, type PaymentPanel } from '../payment-card.service.js';
import { SessionLock } from '../session-lock.js';
import {
  amountPresent,
  hasAmountToken,
  owedAmountsFound,
  receiverName,
  receiverNameMatches,
  receiverTail,
  slipAmount,
  slipDate,
  slipDateInWindow,
} from './slip-match.js';
import type { SlipOcrResult } from './slip-ocr.js';
import { SlipReader } from './slip-reader.js';
import { SlipImagesService } from './slip-images.service.js';

/** One person's paid mark on the bill screen. */
export interface PaidRow {
  playerId: string;
  /** `owner`: the bill's เจ้าของบัญชี (collector). The money goes to them, so they never pay themselves. */
  source: 'slip' | 'host' | 'collector' | 'owner';
  /** ISO time the mark was written. */
  at: string;
  /** A slip credited an amount that no longer matches the player's current bill row. The mark stays; the host decides. */
  amountChangedSince: boolean;
  /** The kept image of the slip behind a `slip` mark, so the host can look at it; null for a tick or once it is purged. */
  imageId: string | null;
}

/** The LINE profile the pay page reads for the viewer. Only `userId` is required to link; the rest is for display. */
export interface LiffUser {
  userId: string;
  displayName: string | null;
  pictureUrl: string | null;
}

export type ClaimOutcome = 'linked' | 'player-taken' | 'account-already-linked' | 'not-on-bill';

/** `locked`: the link stays, the host made it or money has proven it; `unlinked` also when there was no link. */
export type UnclaimOutcome = 'unlinked' | 'locked';

export interface LinkRow {
  playerId: string;
  displayName: string | null;
  linkedBy: 'self' | 'host';
}

/** Why a slip was held for the host instead of marking anyone paid. */
/** A slip the host skipped, kept so the skip can be undone until collection closes. */
export interface SkippedSlip {
  id: string;
  imageId: string | null;
  displayName: string | null;
  pictureUrl: string | null;
  amountSatang: number | null;
  createdAt: string;
  skippedAt: string;
}

/**
 * `overpaid`: the slip is for more than the sender's own share and passed every other auto-pay check; the sender picks
 * who it covers on the pay page (`coverForPayPage`), or the host resolves it like any waiting slip.
 */
export type WaitingReason = 'unmapped' | 'amount' | 'date' | 'receiver' | 'unreadable' | 'stale' | 'collision' | 'undone' | 'overpaid';

/** The pay page's answer to "this slip covers these people". */
export type CoverOutcome = 'paid' | 'gone' | 'exceeds' | 'already-paid' | 'not-on-bill';

export type SubmitOutcome =
  | { kind: 'paid'; playerIds: string[] }
  | { kind: 'waiting'; reason: WaitingReason }
  /** An `overpaid` slip: the sender now picks who it covers (`PayPageView.choice`). */
  | { kind: 'choose' }
  | { kind: 'duplicate' }
  /** The same LINE account sent this slip before and it is still waiting for the host: nothing new is recorded. */
  | { kind: 'already-sent' }
  | { kind: 'not-slip' }
  | { kind: 'unavailable' };

/** A slip held for the host: who sent it, what it showed, and the players it might be for. */
export interface WaitingSlip {
  id: string;
  imageId: string | null;
  linkedPlayerId: string | null;
  reason: WaitingReason;
  displayName: string | null;
  pictureUrl: string | null;
  lineUserId: string;
  /** The one owed amount read from the slip, or null when none or several were found. */
  amountSatang: number | null;
  /** Only on a receiver mismatch: the receiver as read, so the host can fix the saved name. */
  receiverName: string | null;
  receiverTail: string | null;
  createdAt: string;
  /** Unpaid players on the bill whose row equals the slip's amount; every unpaid player when there is no amount. */
  candidatePlayerIds: string[];
}

/** A slip whose reference was already used in the group. The full reference is not shipped, only its tail. */
export interface DuplicateSlip {
  id: string;
  displayName: string | null;
  lineUserId: string;
  referenceTail: string;
  originalPlayerIds: string[];
  createdAt: string;
}

/** What the pay page shows one LINE viewer. Never carries an id other than the claimable players'. */
export interface PayPageView {
  collectionClosed: boolean;
  /** The viewer's own bill row; null when the viewer is not linked to a player on tonight's bill. */
  amountSatang: number | null;
  playerName: string | null;
  /** Unpaid players on the bill that no LINE account is linked to yet: the "this is me" choices. */
  claimable: { playerId: string; name: string }[];
  /** Who the transfer goes to, as the confirmed card shows it. */
  accountName: string;
  alreadyPaid: boolean;
  /** The viewer may undo their own pick and choose again (see `unclaimPlayer` for when that is closed). */
  canChange: boolean;
  /** The night the bill is for, as the card writes it (a stored yyyy-mm-dd becomes a Thai date); null with no date. */
  sessionDate: string | null;
  /**
   * The viewer's own slip for more than their share, waiting for them to say who it covers; null otherwise. Options are
   * the unpaid people owing money, the viewer's own row first.
   */
  choice: {
    amountSatang: number;
    ownPlayerId: string | null;
    options: { playerId: string; name: string; amountSatang: number }[];
  } | null;
}

/** Read-only bill projection for collectors; never includes host review or LINE account data. */
export interface PaymentStatusView {
  closedAt: string | null;
  pendingSlipCount: number;
  sessionDate: string | null;
  rows: { name: string; amountSatang: number; paid: boolean; pending: boolean; amountChangedSince: boolean; owner: boolean }[];
}

/**
 * What a slip may be checked against: the session's group, its current payment panel and the receiver name (the
 * group's saved one, else the confirmed card's; null only when neither has one).
 */
interface SubmitGate {
  groupId: string;
  closedAt: Date | null;
  panel: PaymentPanel;
  savedName: string | null;
  /** When the bill's night ended (when the session was created, if it never ended): the slip date window starts here. */
  billEnd: Date;
  /** The session's own date text (the roster header's), if any. */
  date: string | null;
}

/**
 * Per-person paid state for one session: a `SessionPayment` row exists exactly while the person counts as paid.
 * Written by a matched slip or by the host's tick. Every write runs under the session lock, like the card's.
 */
@Injectable()
export class SlipPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cards: PaymentCardService,
    private readonly lock: SessionLock,
    private readonly reader: SlipReader,
    private readonly plans: PlansService,
    private readonly images: SlipImagesService,
    private readonly lineAccounts: LineAccountsService,
    private readonly collectors: CollectorService
  ) {}

  /**
   * A slip uploaded from the pay page. Marks the sender's own player paid only when every auto-paid rule holds
   * (docs/superpowers/specs/2026-10-30-slip-payment-matching-design.md); anything else is held for the host or
   * recorded as a duplicate. Slip images are kept privately for host review until close or expiry; raw OCR text is never stored or logged.
   */
  async submitSlip(code: string, token: string, user: LiffUser, image: Buffer, now: Date = new Date()): Promise<SubmitOutcome> {
    // Cheap checks first, so a stale link or a free plan never costs an OCR run.
    const initialGate = await this.gate(code, token, now);
    if (!initialGate || initialGate.closedAt) return { kind: 'unavailable' };
    // OCR takes seconds: read outside the lock so the bill screen is not held up meanwhile.
    const read = await this.reader.read(image);
    if (read.kind === 'not-slip') return { kind: 'not-slip' };
    const { qr, ocr } = read;

    return this.images.withGroupLock(initialGate.groupId, () => this.lock.run(code, async (): Promise<SubmitOutcome> => {
      // The card may have been reconfirmed, re-priced or unconfirmed, or the plan lapsed, while the slip was read.
      const gate = await this.gate(code, token, now);
      if (!gate || gate.closedAt) return { kind: 'unavailable' };
      const { groupId } = gate;
      const { reference, bankCode } = qr;

      if (await this.prisma.slipReference.findUnique({ where: { groupId_reference: { groupId, reference } } })) {
        // A re-send of the sender's own slip still in the host's waiting list is not news for the host, and the
        // sender only needs to hear it arrived. Only the same account is told: anyone else learns nothing about it.
        const waiting = await this.prisma.pendingSlip.findFirst({
          where: { groupId, reference, lineUserId: user.userId, resolvedAt: null },
          select: { id: true },
        });
        if (waiting) return { kind: 'already-sent' };
        return this.recordDuplicate(groupId, code, reference, user);
      }
      try {
        await this.prisma.slipReference.create({
          data: { groupId, reference, bankCode, sessionId: code, lineUserId: user.userId },
        });
      } catch (error) {
        // The lock is per session, so another session of this group can record the same reference between the
        // check and the create. Its row won: this slip is the duplicate.
        if (!isUniqueViolation(error)) throw error;
        return this.recordDuplicate(groupId, code, reference, user);
      }

      try {
        await this.images.save(code, reference, image, now);
        return await this.settle(code, gate, reference, user, ocr, now);
      } catch (error) {
        // Nothing was recorded for this slip, so release its reference: sending it again must not be a duplicate.
        try {
          await this.images.removeForReference(code, reference);
        } finally {
          // File deletion failure must not consume a transfer that never received a payment or review row.
          await this.prisma.slipReference.deleteMany({ where: { groupId, reference, sessionId: code } });
        }
        throw error;
      }
    }));
  }

  /**
   * What the pay page shows this viewer, or null when the page is not available: wrong or old pay token, a plan below
   * host (lapsed counts as free), no confirmed card, or no such session. The caller answers every null the same way.
   */
  async payPageView(code: string, token: string | undefined, user: LiffUser, now: Date = new Date()): Promise<PayPageView | null> {
    const gate = await this.gate(code, token, now);
    if (!gate) return null;
    const { groupId, panel, savedName, billEnd, date } = gate;
    const paid = await this.paidIds(code);
    const linkedId = await this.linkedPlayerOf(groupId, user.userId);
    const row = linkedId === null ? undefined : panel.rows.find((r) => r.playerId === linkedId);

    const links = await this.prisma.playerLineAccount.findMany({
      where: { groupId, playerId: { in: panel.rows.map((r) => r.playerId) } },
      select: { playerId: true },
    });
    const linked = new Set(links.map((l) => l.playerId));
    return {
      collectionClosed: gate.closedAt !== null,
      amountSatang: row?.amountSatang ?? null,
      playerName: row?.name ?? null,
      claimable: panel.rows
        .filter((r) => !paid.has(r.playerId) && !linked.has(r.playerId))
        .map((r) => ({ playerId: r.playerId, name: r.name })),
      accountName: panel.account?.name ?? savedName ?? '',
      alreadyPaid: linkedId !== null && paid.has(linkedId),
      canChange: gate.closedAt === null && (await this.selfChangeable(groupId, user.userId, paid)),
      sessionDate: date === null || date.trim() === '' ? null : cardDate(date, billEnd),
      choice: await this.choiceFor(code, gate, user, paid, linkedId),
    };
  }

  /** The viewer's unresolved `overpaid` slip, latest first, as the pay page's "who does this cover" choice. */
  private async choiceFor(code: string, gate: SubmitGate, user: LiffUser, paid: Set<string>, ownPlayerId: string | null): Promise<PayPageView['choice']> {
    if (gate.closedAt !== null || gate.panel.stale) return null;
    const slip = await this.overpaidSlipOf(code, user);
    if (!slip || slip.amountSatang === null) return null;
    const options = gate.panel.rows
      .filter((r) => !paid.has(r.playerId) && r.amountSatang > 0)
      .map((r) => ({ playerId: r.playerId, name: r.name, amountSatang: r.amountSatang }))
      .sort((a, b) => Number(b.playerId === ownPlayerId) - Number(a.playerId === ownPlayerId));
    return { amountSatang: slip.amountSatang, ownPlayerId: ownPlayerId !== null && options.some((o) => o.playerId === ownPlayerId) ? ownPlayerId : null, options };
  }

  private overpaidSlipOf(code: string, user: LiffUser) {
    return this.prisma.pendingSlip.findFirst({
      where: { sessionId: code, lineUserId: user.userId, reason: 'overpaid', resolvedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /**
   * The pay page's "this slip covers these people", for the sender's own `overpaid` slip. Exactly the host's resolve
   * (same cap: the picked total may not exceed the slip amount; same all-or-nothing write), behind the pay page's gates
   * and a card that is not stale. Null when gated out.
   */
  async coverForPayPage(code: string, token: string | undefined, user: LiffUser, playerIds: string[], now: Date = new Date()): Promise<CoverOutcome | null> {
    const gate = await this.gate(code, token, now);
    if (!gate || gate.closedAt) return null;
    if (gate.panel.stale) return 'gone';
    const slip = await this.overpaidSlipOf(code, user);
    if (!slip || slip.amountSatang === null) return 'gone';
    try {
      await this.resolveWaiting(code, slip.id, { coversPlayerIds: playerIds, senderPlayerId: null, reviewedAmountSatang: slip.amountSatang });
      return 'paid';
    } catch (error) {
      if (error instanceof NotFoundException) return 'gone';
      if (!(error instanceof ConflictException)) throw error;
      switch ((error.getResponse() as { code?: string }).code) {
        case 'SLIP_AMOUNT_MISMATCH':
        case 'COVERS_REQUIRED':
          return 'exceeds';
        case 'PLAYER_ALREADY_PAID':
          return 'already-paid';
        case 'PLAYER_NOT_ON_BILL':
          return 'not-on-bill';
        case 'COLLECTION_CLOSED':
          return null;
        default:
          throw error;
      }
    }
  }

  /**
   * What the pay page needs before it can log anyone in: the LIFF id. Needs no LINE identity, so it sits behind the
   * same gates as the page itself (pay token, plan, confirmed card) plus a configured LIFF id; null when any fails.
   */
  async payPageConfig(code: string, token: string | undefined, now: Date = new Date()): Promise<{ liffId: string } | null> {
    const { liffId } = lineConfig();
    if (liffId === null) return null;
    if (!(await this.gate(code, token, now))) return null;
    return { liffId };
  }

  /** The pay page's "this is me": `claimPlayer` behind the same gates as the page itself; null when gated out. */
  async claimForPayPage(
    code: string,
    token: string | undefined,
    user: LiffUser,
    playerId: string,
    now: Date = new Date()
  ): Promise<ClaimOutcome | null> {
    const gate = await this.gate(code, token, now);
    if (!gate || gate.closedAt) return null;
    try { return await this.claimPlayer(code, user, playerId); }
    catch (error) {
      if (error instanceof ConflictException && (error.getResponse() as {code?:string}).code === 'COLLECTION_CLOSED') return null;
      throw error;
    }
  }

  /** The pay page's "not my name": `unclaimPlayer` behind the same gates as the page itself; null when gated out. */
  async unclaimForPayPage(code: string, token: string | undefined, user: LiffUser, now: Date = new Date()): Promise<UnclaimOutcome | null> {
    const gate = await this.gate(code, token, now);
    if (!gate || gate.closedAt) return null;
    try { return await this.unclaimPlayer(code, user); }
    catch (error) {
      if (error instanceof ConflictException && (error.getResponse() as {code?:string}).code === 'COLLECTION_CLOSED') return null;
      throw error;
    }
  }

  async paymentStatusView(code: string, token: string | undefined, now: Date = new Date()): Promise<PaymentStatusView | null> {
    return this.lock.run(code, async () => {
      const gate = await this.gate(code, token, now);
      if (!gate) return null;
      const stored = await this.prisma.sessionPayment.findMany({ where: { sessionId: code } });
      const paid = new Map(stored.map((p) => [p.playerId, p]));
      const ownerId = await this.ownerOf(code);
      const pending = await this.prisma.pendingSlip.findMany({ where: { sessionId: code, resolvedAt: null } });
      const links = await this.prisma.playerLineAccount.findMany({ where: { groupId: gate.groupId } });
      const linked = new Map(links.map((l) => [l.lineUserId, l.playerId]));
      const rows = gate.panel.rows.map((r) => {
        const owner = r.playerId === ownerId;
        const mark = owner ? undefined : paid.get(r.playerId);
        return {
          // The owner sorts first among the paid: they never had anything to send.
          paidAt: owner ? 0 : (mark?.createdAt.getTime() ?? null),
          row: {
            name: r.name, amountSatang: r.amountSatang, paid: owner || mark !== undefined,
            pending: !owner && !mark && pending.some((p) => linked.get(p.lineUserId) === r.playerId && (p.reviewedAmountSatang ?? p.amountSatang) === r.amountSatang),
            amountChangedSince: mark !== undefined && mark.amountSatang !== null && mark.amountSatang !== r.amountSatang,
            owner,
          },
        };
      });
      // Who still owes first (bill order), then slips waiting for the host, then the paid, earliest payer first.
      // Only the order carries the pay time, never a field.
      const order = (r: (typeof rows)[number]) => (r.paidAt !== null ? 2 : r.row.pending ? 1 : 0);
      rows.sort((a, b) => order(a) - order(b) || (a.paidAt ?? 0) - (b.paidAt ?? 0));
      return {
        closedAt: gate.closedAt?.toISOString() ?? null,
        pendingSlipCount: pending.length,
        sessionDate: gate.date === null || gate.date.trim() === '' ? null : cardDate(gate.date, gate.billEnd),
        rows: rows.map((r) => r.row),
      };
    });
  }

  /**
   * The host or collector's way in: the pay page's gate holds and LINE's verified user matches the current group
   * owner or the bill's live collector. Source comes from this check, never from the browser.
   */
  async collectorAccess(
    code: string,
    token: string | undefined,
    user: LiffUser,
    now: Date = new Date()
  ): Promise<{ panel: PaymentPanel; source: 'host' | 'collector' } | null> {
    const role = await this.collectorRole(code, token, user, now);
    return role?.source ? { panel: role.panel, source: role.source } : null;
  }

  /**
   * Whether this viewer manages the bill, or null when the pay-page gate fails. Ownership and LINE links are read
   * live; an owner who is also the collector keeps host attribution. The public controller exposes only collector.
   */
  async collectorRole(
    code: string,
    token: string | undefined,
    user: LiffUser,
    now: Date = new Date()
  ): Promise<{ collector: boolean; panel: PaymentPanel; source: 'host' | 'collector' | null } | null> {
    const gate = await this.gate(code, token, now);
    if (!gate) return null;
    const group = await this.prisma.group.findUnique({
      where: { code: gate.groupId },
      select: { owner: { select: { lineUserId: true } } },
    });
    if (group?.owner?.lineUserId === user.userId) {
      return { collector: true, panel: gate.panel, source: 'host' };
    }
    const collector = await this.collectors.forBill(code);
    const allowed = collector !== null && collector.lineUserId === user.userId;
    return { collector: allowed, panel: gate.panel, source: allowed ? 'collector' : null };
  }

  async getPaid(code: string): Promise<PaidRow[]> {
    const panel = await this.cards.panel(code);
    const current = new Map(panel.rows.map((r) => [r.playerId, r.amountSatang]));
    const ownerId = await this.ownerOf(code);
    const stored = (await this.prisma.sessionPayment.findMany({ where: { sessionId: code }, orderBy: { createdAt: 'asc' } }))
      .filter((p) => p.playerId !== ownerId);
    const images = new Map((await this.images.list(code)).map((i) => [i.reference, i.id]));
    // The owner's row is derived, never stored, and listed first: their share is already in their own account.
    const owner: PaidRow[] = ownerId !== null && current.has(ownerId)
      ? [{ playerId: ownerId, source: 'owner', at: new Date(0).toISOString(), amountChangedSince: false, imageId: null }]
      : [];
    return [...owner, ...stored.map((p) => ({
      playerId: p.playerId,
      source: (p.source === 'slip' || p.source === 'collector' ? p.source : 'host') as PaidRow['source'],
      at: p.createdAt.toISOString(),
      amountChangedSince: p.amountSatang !== null && p.amountSatang !== current.get(p.playerId),
      imageId: p.source === 'slip' && p.reference !== null ? (images.get(p.reference) ?? null) : null,
    }))];
  }

  /**
   * The bill's เจ้าของบัญชี (the collector picked in payment settings), who counts as paid without a mark: the money
   * is sent to them, so their own share never has to be. Null when the bill has no collector.
   */
  private async ownerOf(code: string): Promise<string | null> {
    return (await this.collectors.forBill(code))?.playerId ?? null;
  }

  /**
   * The host, or the collector from LINE, marks a person paid. Already paid (by a slip or an earlier tick) stays as
   * it is, whoever marked it first.
   */
  tick(code: string, playerId: string, source: 'host' | 'collector' = 'host'): Promise<void> {
    return this.lock.run(code, async () => {
      await this.assertOpen(code);
      const panel = await this.cards.panel(code);
      if (!panel.rows.some((r) => r.playerId === playerId)) throw new ConflictException({ code: 'PLAYER_NOT_ON_BILL' });
      await this.prisma.sessionPayment.upsert({
        where: { sessionId_playerId: { sessionId: code, playerId } },
        create: { sessionId: code, playerId, source },
        update: {},
      });
    });
  }

  /**
   * Removes the paid mark if there is one. A mark that came from a slip sends that slip back to the host's waiting list
   * (reason `undone`) instead of dropping it: its reference stays used, so the sender cannot send it again, and without
   * this a mistaken undo left the slip with no way back but a host tick.
   */
  untick(code: string, playerId: string): Promise<void> {
    return this.lock.run(code, async () => {
      await this.assertOpen(code);
      await this.cards.panel(code);
      const mark = await this.prisma.sessionPayment.findUnique({ where: { sessionId_playerId: { sessionId: code, playerId } } });
      if (!mark) return;
      const reopen = mark.source === 'slip' && mark.reference !== null ? await this.reopenWrite(code, mark.reference, mark.amountSatang) : null;
      await this.prisma.$transaction([
        this.prisma.sessionPayment.delete({ where: { id: mark.id } }),
        ...(reopen ? [reopen()] : []),
      ]);
    });
  }

  /**
   * The write that puts an undone slip back in the waiting list, or null when there is nothing to put back. A slip the
   * host resolved reopens its own row; an auto-paid one never had a row, so one is made from the slip's sender. A slip
   * still waiting (it covered someone else who was undone first) needs nothing. Returned as a thunk: an async function
   * returning the Prisma call itself would run it here, outside the caller's transaction.
   */
  private async reopenWrite(code: string, reference: string, amountSatang: number | null) {
    const groupId = await this.groupOf(code);
    const rows = await this.prisma.pendingSlip.findMany({ where: { sessionId: code, reference }, orderBy: { createdAt: 'desc' } });
    if (rows.some((r) => r.resolvedAt === null)) return null;
    if (rows.length > 0) {
      const id = rows[0].id;
      return () => this.prisma.pendingSlip.update({ where: { id }, data: { resolvedAt: null, reason: 'undone' } });
    }
    const sent = await this.prisma.slipReference.findUnique({ where: { groupId_reference: { groupId, reference } } });
    if (!sent?.lineUserId) return null;
    const account = await this.prisma.lineAccount.findUnique({ where: { lineUserId: sent.lineUserId } });
    const lineUserId = sent.lineUserId;
    return () => this.prisma.pendingSlip.create({
      data: {
        sessionId: code,
        groupId,
        reference,
        lineUserId,
        displayName: account?.displayName ?? null,
        pictureUrl: account?.pictureUrl ?? null,
        // The auto-pay rule only pays an exact match, so the paid share is the amount read off the slip.
        amountSatang,
        reason: 'undone',
      },
    });
  }

  /**
   * A viewer claims "this is me" on the pay page. One account per player and one player per account within the group;
   * the first claim wins and a later one never overwrites it (the host can repoint with `setLink`).
   */
  claimPlayer(code: string, user: LiffUser, playerId: string): Promise<ClaimOutcome> {
    return this.lock.run(code, async () => {
      await this.assertOpen(code);
      const panel = await this.cards.panel(code);
      if (!panel.rows.some((r) => r.playerId === playerId)) return 'not-on-bill';
      const groupId = await this.groupOf(code);
      // A bill row always belongs to the session's group, but a link row must never depend on that being true.
      if (!(await this.prisma.player.findFirst({ where: { id: playerId, groupId }, select: { id: true } }))) return 'not-on-bill';

      const existing = await this.existingOutcome(groupId, user.userId, playerId);
      if (existing) return existing;
      // The link points at the account, so the account (and its listing in this group) comes first.
      await this.lineAccounts.touch(
        groupId,
        { lineUserId: user.userId, displayName: user.displayName, pictureUrl: user.pictureUrl },
        'claim'
      );
      try {
        await this.prisma.playerLineAccount.create({
          data: { groupId, playerId, lineUserId: user.userId, linkedBy: 'self' },
        });
      } catch (error) {
        // The lock is per session, so a claim from another session of this group can win between the check and the
        // create. Judge the row that won the same way as the pre-check does.
        if (!isUniqueViolation(error)) throw error;
        return (await this.existingOutcome(groupId, user.userId, playerId)) ?? 'player-taken';
      }
      return 'linked';
    });
  }

  /**
   * A viewer undoes their own "this is me" so they can pick again: a wrong first pick is otherwise fixable only by the
   * host. Closed once the link is the host's, or once money has proven it: the linked player is paid tonight (by any
   * path), or a slip this account sent has ever paid that player. A slip already waiting stays with the host as it is.
   */
  unclaimPlayer(code: string, user: LiffUser): Promise<UnclaimOutcome> {
    return this.lock.run(code, async () => {
      await this.assertOpen(code);
      const groupId = await this.groupOf(code);
      const link = await this.prisma.playerLineAccount.findUnique({
        where: { groupId_lineUserId: { groupId, lineUserId: user.userId } },
      });
      if (!link) return 'unlinked';
      if (!(await this.selfChangeable(groupId, user.userId, await this.paidIds(code)))) return 'locked';
      await this.prisma.playerLineAccount.delete({ where: { id: link.id } });
      return 'unlinked';
    });
  }

  /** Whether this account has a link it made itself that money has not proven yet (`unclaimPlayer`'s rule). */
  private async selfChangeable(groupId: string, lineUserId: string, paidTonight: Set<string>): Promise<boolean> {
    const link = await this.prisma.playerLineAccount.findUnique({ where: { groupId_lineUserId: { groupId, lineUserId } } });
    if (!link || link.linkedBy !== 'self' || paidTonight.has(link.playerId)) return false;
    const sent = await this.prisma.slipReference.findMany({ where: { groupId, lineUserId }, select: { reference: true } });
    if (sent.length === 0) return true;
    const proven = await this.prisma.sessionPayment.findFirst({
      where: { playerId: link.playerId, source: 'slip', reference: { in: sent.map((r) => r.reference) }, session: { groupId } },
      select: { id: true },
    });
    return proven === null;
  }

  /** The player this LINE account is linked to in the group, if any. */
  async linkedPlayerOf(groupCode: string, lineUserId: string): Promise<string | null> {
    const link = await this.prisma.playerLineAccount.findUnique({
      where: { groupId_lineUserId: { groupId: groupCode, lineUserId } },
      select: { playerId: true },
    });
    return link?.playerId ?? null;
  }

  /** Every link in the session's group, oldest first, with the account's current LINE name. */
  async listLinks(code: string): Promise<LinkRow[]> {
    const groupId = await this.groupOf(code);
    const links = await this.prisma.playerLineAccount.findMany({
      where: { groupId },
      orderBy: { createdAt: 'asc' },
      include: { lineAccount: true },
    });
    return links.map((l) => ({
      playerId: l.playerId,
      displayName: l.lineAccount.displayName,
      linkedBy: l.linkedBy === 'self' ? 'self' : 'host',
    }));
  }

  /** Host: points the player at this account (replacing any link the player has), or with `null` removes the link. */
  setLink(code: string, playerId: string, lineUserId: string | null): Promise<void> {
    return this.lock.run(code, async () => {
      await this.assertOpen(code);
      const groupId = await this.groupOf(code);
      if (lineUserId === null) {
        await this.prisma.playerLineAccount.deleteMany({ where: { groupId, playerId } });
        return;
      }
      if (!(await this.prisma.player.findFirst({ where: { id: playerId, groupId }, select: { id: true } }))) {
        throw new ConflictException({ code: 'PLAYER_NOT_IN_GROUP' });
      }
      const byAccount = await this.prisma.playerLineAccount.findUnique({
        where: { groupId_lineUserId: { groupId, lineUserId } },
      });
      if (byAccount && byAccount.playerId !== playerId) throw new ConflictException({ code: 'ACCOUNT_ALREADY_LINKED' });
      // The link points at the account; this call carries no profile, so a stored name and picture stay as they are.
      await this.lineAccounts.touch(groupId, { lineUserId, displayName: null, pictureUrl: null }, 'host');
      try {
        if (byAccount) {
          // Already this player's account: only the label changes; the link's age stays.
          await this.prisma.playerLineAccount.update({ where: { id: byAccount.id }, data: { linkedBy: 'host' } });
          return;
        }
        await this.prisma.$transaction([
          this.prisma.playerLineAccount.deleteMany({ where: { groupId, playerId } }),
          this.prisma.playerLineAccount.create({ data: { groupId, playerId, lineUserId, linkedBy: 'host' } }),
        ]);
      } catch (error) {
        // Another session of this group linked the account in between (the lock is per session); the transaction
        // rolled back, so nothing changed.
        if (isUniqueViolation(error)) throw new ConflictException({ code: 'ACCOUNT_ALREADY_LINKED' });
        throw error;
      }
    });
  }

  /** Slips held for the host in this session, oldest first, each with the players it could be for. */
  async listWaiting(code: string): Promise<WaitingSlip[]> {
    await this.groupOf(code);
    const panel = await this.cards.panel(code);
    const paid = await this.paidIds(code);
    const unpaid = panel.rows.filter((r) => !paid.has(r.playerId));
    const rows = await this.prisma.pendingSlip.findMany({
      where: { sessionId: code, resolvedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const imageList = await this.images.list(code);
    const imageByReference = new Map(imageList.map((i) => [i.reference, i.id]));
    const links = await this.prisma.playerLineAccount.findMany({ where: { groupId: await this.groupOf(code) } });
    const linked = new Map(links.map((l) => [l.lineUserId, l.playerId]));
    return rows.map((s) => {
      // A slip back from an undone payment was already reviewed once: the host's amount beats the OCR read.
      const amountSatang = s.reviewedAmountSatang ?? s.amountSatang;
      return {
      id: s.id,
      imageId: imageByReference.get(s.reference) ?? null,
      linkedPlayerId: linked.get(s.lineUserId) ?? null,
      reason: s.reason as WaitingReason,
      displayName: s.displayName,
      pictureUrl: s.pictureUrl,
      lineUserId: s.lineUserId,
      amountSatang,
      receiverName: s.receiverName,
      receiverTail: s.receiverTail,
      createdAt: s.createdAt.toISOString(),
      // Nobody owing nothing is ever a match for an amount.
      candidatePlayerIds: unpaid
        .filter((r) => (amountSatang === null ? true : r.amountSatang > 0 && r.amountSatang === amountSatang))
        .map((r) => r.playerId),
      };
    });
  }

  /**
   * Host: this slip covers these players (all marked paid, those already paid left alone) and, optionally, its sender is
   * this player (the account is linked for future nights). Either everything is written or nothing is.
   */
  resolveWaiting(code: string, id: string, input: { coversPlayerIds: string[]; senderPlayerId: string | null; reviewedAmountSatang?: number }): Promise<void> {
    return this.lock.run(code, async () => {
      await this.assertOpen(code);
      const slip = await this.prisma.pendingSlip.findFirst({ where: { id, sessionId: code, resolvedAt: null } });
      if (!slip) throw new NotFoundException();
      const covers = [...new Set(input.coversPlayerIds)];
      if (covers.length === 0) throw new ConflictException({ code: 'COVERS_REQUIRED' });
      const panel = await this.cards.panel(code);
      const onBill = new Set(panel.rows.map((r) => r.playerId));
      if (covers.some((playerId) => !onBill.has(playerId))) throw new ConflictException({ code: 'PLAYER_NOT_ON_BILL' });
      const paid = await this.paidIds(code);

      if (covers.some((id) => paid.has(id))) throw new ConflictException({ code: 'PLAYER_ALREADY_PAID' });
      const reviewedAmount = input.reviewedAmountSatang ?? slip.amountSatang;
      if (reviewedAmount === null || reviewedAmount === undefined) throw new ConflictException({ code: 'SLIP_AMOUNT_REQUIRED' });
      if (!Number.isSafeInteger(reviewedAmount) || reviewedAmount <= 0 || reviewedAmount > 2_147_483_647) {
        throw new ConflictException({ code: 'SLIP_AMOUNT_INVALID' });
      }
      const selectedTotal = panel.rows.filter((r) => covers.includes(r.playerId)).reduce((sum, r) => sum + r.amountSatang, 0);
      if (selectedTotal > reviewedAmount) throw new ConflictException({ code: 'SLIP_AMOUNT_MISMATCH' });

      // Judge the link before anything is written, so a refusal leaves no payment behind.
      const groupId = slip.groupId;
      const link = input.senderPlayerId === null ? null : await this.linkWrites(groupId, input.senderPlayerId, slip);

      const writes = [
        ...covers
          .filter((playerId) => !paid.has(playerId))
          // Snapshot each covered player's own share so later bill edits remain visible.
          .map((playerId) =>
            this.prisma.sessionPayment.create({
              data: { sessionId: code, playerId, source: 'slip', amountSatang: panel.rows.find((r) => r.playerId === playerId)!.amountSatang, reference: slip.reference },
            })
          ),
        ...(link ?? []),
        this.prisma.pendingSlip.update({ where: { id }, data: { resolvedAt: new Date(), reviewedAmountSatang: reviewedAmount, reviewedAt: new Date() } }),
      ];
      try {
        await this.prisma.$transaction(writes);
      } catch (error) {
        // Another session of this group linked the account in between (the lock is per session); nothing was written.
        if (link && isUniqueViolation(error)) throw new ConflictException({ code: 'ACCOUNT_ALREADY_LINKED' });
        throw error;
      }
    });
  }

  /**
   * Slips the host skipped (ข้าม) in this session, latest skip first, so a mistaken skip can be brought back. A resolved
   * row is skipped when no paid mark of this session carries its reference: that also catches a slip whose payments were
   * undone before undo started sending slips back.
   */
  async listSkipped(code: string): Promise<SkippedSlip[]> {
    await this.groupOf(code);
    const rows = await this.prisma.pendingSlip.findMany({
      where: { sessionId: code, resolvedAt: { not: null } },
      orderBy: [{ resolvedAt: 'desc' }, { id: 'asc' }],
    });
    const used = await this.usedReferences(code);
    const imageByReference = new Map((await this.images.list(code)).map((i) => [i.reference, i.id]));
    return rows
      .filter((s) => !used.has(s.reference))
      .map((s) => ({
        id: s.id,
        imageId: imageByReference.get(s.reference) ?? null,
        displayName: s.displayName,
        pictureUrl: s.pictureUrl,
        amountSatang: s.reviewedAmountSatang ?? s.amountSatang,
        createdAt: s.createdAt.toISOString(),
        skippedAt: s.resolvedAt!.toISOString(),
      }));
  }

  /** Host: a skipped slip goes back to the waiting list as it was. A slip that paid someone is not skipped and is refused. */
  restoreWaiting(code: string, id: string): Promise<void> {
    return this.lock.run(code, async () => {
      await this.assertOpen(code);
      const slip = await this.prisma.pendingSlip.findFirst({ where: { id, sessionId: code, resolvedAt: { not: null } } });
      if (!slip || (await this.usedReferences(code)).has(slip.reference)) throw new NotFoundException();
      await this.prisma.pendingSlip.update({ where: { id }, data: { resolvedAt: null } });
    });
  }

  private async usedReferences(code: string): Promise<Set<string>> {
    const marks = await this.prisma.sessionPayment.findMany({
      where: { sessionId: code, reference: { not: null } },
      select: { reference: true },
    });
    return new Set(marks.map((m) => m.reference!));
  }

  /** Host: nothing to credit for this slip. It leaves the list (to the skipped list); no one is marked paid. */
  dismissWaiting(code: string, id: string): Promise<void> {
    return this.lock.run(code, async () => {
      const { count } = await this.prisma.pendingSlip.updateMany({
        where: { id, sessionId: code, resolvedAt: null },
        data: { resolvedAt: new Date() },
      });
      if (count === 0) throw new NotFoundException();
    });
  }

  /** Duplicate slips of this session the host has not dismissed, oldest first. */
  async listDuplicates(code: string): Promise<DuplicateSlip[]> {
    await this.groupOf(code);
    const rows = await this.prisma.slipDuplicate.findMany({
      where: { sessionId: code, dismissedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((d) => ({
      id: d.id,
      displayName: d.displayName,
      lineUserId: d.lineUserId,
      referenceTail: d.reference.slice(-6),
      originalPlayerIds: parseIds(d.originalPlayerIds),
      createdAt: d.createdAt.toISOString(),
    }));
  }

  dismissDuplicate(code: string, id: string): Promise<void> {
    return this.lock.run(code, async () => {
      const { count } = await this.prisma.slipDuplicate.updateMany({
        where: { id, sessionId: code, dismissedAt: null },
        data: { dismissedAt: new Date() },
      });
      if (count === 0) throw new NotFoundException();
    });
  }

  /**
   * Host: the receiver on a waiting slip is the host's own account, so make its name the saved one (bank and number
   * stay). Marks no one paid and leaves the slip waiting for explicit amount-safe review.
   */
  updateSavedReceiverName(code: string, waitingId: string): Promise<void> {
    return this.lock.run(code, async () => {
      const slip = await this.prisma.pendingSlip.findFirst({ where: { id: waitingId, sessionId: code, resolvedAt: null } });
      if (!slip) throw new NotFoundException();
      if (slip.reason !== 'receiver' || slip.receiverName === null) {
        throw new ConflictException({ code: 'NAME_UPDATE_NOT_APPLICABLE' });
      }
      const group = await this.prisma.group.findUnique({ where: { code: slip.groupId }, select: { payAccount: true } });
      const saved = parsePayAccount(group?.payAccount ?? null);
      if (!saved) throw new ConflictException({ code: 'NAME_UPDATE_NOT_APPLICABLE' });
      const result = validatePayAccount({ bank: saved.bank, number: saved.number, name: slip.receiverName });
      if (!result.ok || result.value === null) throw new ConflictException({ code: 'PAY_ACCOUNT_INVALID' });
      await this.prisma.group.update({ where: { code: slip.groupId }, data: { payAccount: serializePayAccount(result.value) } });
    });
  }

  /** What an existing link says about a claim, or null when neither the account nor the player is linked. */
  private async existingOutcome(groupId: string, lineUserId: string, playerId: string): Promise<ClaimOutcome | null> {
    const byAccount = await this.prisma.playerLineAccount.findUnique({
      where: { groupId_lineUserId: { groupId, lineUserId } },
    });
    if (byAccount) return byAccount.playerId === playerId ? 'linked' : 'account-already-linked';
    const byPlayer = await this.prisma.playerLineAccount.findUnique({ where: { groupId_playerId: { groupId, playerId } } });
    return byPlayer ? 'player-taken' : null;
  }

  /** Null when the slip cannot count here: wrong or old token, a plan below host (lapsed counts as free), or no confirmed card. */
  private async gate(code: string, token: string | undefined, now: Date): Promise<SubmitGate | null> {
    if (!(await this.cards.tokenValid(code, token))) return null;
    const session = await this.prisma.session.findUnique({
      where: { code },
      select: { groupId: true, paymentCollectionClosedAt: true, date: true, endedAt: true, createdAt: true, group: { select: { payAccount: true } } },
    });
    if (!session) return null;
    if (!planAtLeast(await this.plans.planForGroup(session.groupId, now), 'host')) return null;
    const panel = await this.cards.panel(code, now);
    if (!panel.confirmed) return null;
    // The group's current saved name, not tonight's frozen account, so a fixed name helps every slip from now on.
    // A group with none still has the account the host typed for tonight in the confirmed card: check against that.
    const savedName = parsePayAccount(session.group.payAccount)?.name ?? panel.account?.name ?? null;
    const billEnd = session.endedAt ?? session.createdAt;
    return { groupId: session.groupId, closedAt: session.paymentCollectionClosedAt, panel, savedName, billEnd, date: session.date };
  }

  /** Decides a slip whose reference is now recorded: the sender's own player paid, or a waiting slip for the host. */
  private async settle(
    code: string,
    gate: SubmitGate,
    reference: string,
    user: LiffUser,
    ocr: SlipOcrResult,
    now: Date
  ): Promise<SubmitOutcome> {
    const { groupId, panel } = gate;
    // Once per accepted slip, before the paid/held branch, so both outcomes list the sender in the group. The listing
    // is a convenience: a failure is logged and must not refuse a valid slip (the caller would release its reference).
    try {
      await this.lineAccounts.touch(
        groupId,
        { lineUserId: user.userId, displayName: user.displayName, pictureUrl: user.pictureUrl },
        'slip',
        now
      );
    } catch (error) {
      console.error('[slip-payments] could not record the sender as a LINE account', error);
    }
    const paid = await this.paidIds(code);
    const unpaid = panel.rows.filter((r) => !paid.has(r.playerId));

    let reason = await this.waitingReason(gate, unpaid, user, ocr, now);
    if (typeof reason !== 'string') {
      const row = reason;
      try {
        await this.prisma.sessionPayment.create({
          data: { sessionId: code, playerId: row.playerId, source: 'slip', amountSatang: row.amountSatang, reference },
        });
        return { kind: 'paid', playerIds: [row.playerId] };
      } catch (error) {
        // Paid by some other path in between: never a second mark, the host looks at it.
        if (!isUniqueViolation(error)) throw error;
        reason = 'collision';
      }
    }

    // Keep a unique OCR amount even when nobody on this bill owes it.
    const readAmount = slipAmount(ocr.text);
    await this.prisma.pendingSlip.create({
      data: {
        sessionId: code,
        groupId,
        reference,
        lineUserId: user.userId,
        displayName: user.displayName,
        pictureUrl: user.pictureUrl,
        amountSatang: readAmount,
        // Only on a receiver mismatch, so the host can fix the saved name: the receiver as read, never the OCR text.
        receiverName: reason === 'receiver' ? receiverName(ocr.lines) : null,
        receiverTail: reason === 'receiver' ? receiverTail(ocr.text) : null,
        reason,
      },
    });
    return reason === 'overpaid' ? { kind: 'choose' } : { kind: 'waiting', reason };
  }

  /** The auto-paid rule, in order: the first rule that fails is the reason; when all hold, the row to pay. */
  private async waitingReason(
    { groupId, panel, savedName, billEnd }: SubmitGate,
    unpaid: PaymentPanel['rows'],
    user: LiffUser,
    ocr: SlipOcrResult,
    now: Date
  ): Promise<WaitingReason | PaymentPanel['rows'][number]> {
    // Amounts are moving until the host confirms again.
    if (panel.stale) return 'stale';
    const playerId = await this.linkedPlayerOf(groupId, user.userId);
    if (playerId === null) return 'unmapped';
    // Not on tonight's bill, or already paid.
    const row = unpaid.find((r) => r.playerId === playerId);
    if (!row) return 'collision';
    // amountPresent never finds zero, so a player owing nothing is never auto-matched.
    if (!amountPresent(ocr.text, row.amountSatang)) {
      if (!hasAmountToken(ocr.text)) return 'unreadable';
      // More than their own share (paying for friends too): every other rule still holds before the sender may choose.
      const read = slipAmount(ocr.text);
      if (row.amountSatang <= 0 || read === null || read <= row.amountSatang) return 'amount';
      if (!slipDateInWindow(slipDate(ocr.text), billEnd, now)) return 'date';
      if (savedName !== null && !receiverNameMatches(ocr.lines, savedName)) return 'receiver';
      return 'overpaid';
    }
    // Call 1: two different owed amounts on one slip is not a match. Repeated values collapse, so a night where
    // everyone owes the same still pays; zero is never an owed amount found.
    if (owedAmountsFound(ocr.text, unpaid.map((r) => r.amountSatang)).length !== 1) return 'amount';
    // A genuine slip of the right amount from another night (last week's, made before references were recorded) must
    // not pay tonight: the printed date must fall from the day before the bill ended to the day after today. A date
    // that cannot be read fails closed: the host decides.
    if (!slipDateInWindow(slipDate(ocr.text), billEnd, now)) return 'date';
    if (savedName !== null && !receiverNameMatches(ocr.lines, savedName)) return 'receiver';
    return row;
  }

  /** A slip whose reference was already used in the group: noted for the host, never paying anyone. */
  private async recordDuplicate(groupId: string, code: string, reference: string, user: LiffUser): Promise<SubmitOutcome> {
    const originals = await this.prisma.sessionPayment.findMany({
      where: { reference, session: { groupId } },
      select: { playerId: true },
      orderBy: { createdAt: 'asc' },
    });
    await this.prisma.slipDuplicate.create({
      data: {
        groupId,
        sessionId: code,
        reference,
        lineUserId: user.userId,
        displayName: user.displayName,
        originalPlayerIds: JSON.stringify([...new Set(originals.map((p) => p.playerId))]),
      },
    });
    return { kind: 'duplicate' };
  }

  /** The player ids that currently count as paid in the session: a mark, or being the bill's เจ้าของบัญชี. */
  private async paidIds(code: string): Promise<Set<string>> {
    const rows = await this.prisma.sessionPayment.findMany({ where: { sessionId: code }, select: { playerId: true } });
    const ids = new Set(rows.map((p) => p.playerId));
    const ownerId = await this.ownerOf(code);
    if (ownerId !== null) ids.add(ownerId);
    return ids;
  }

  /**
   * The writes that make the slip's account this player's (the rules of `setLink`, labelled as the host's), or a thrown
   * refusal. Only the account directory is written here (the link needs its account to exist); the link writes are
   * returned for the caller's transaction.
   */
  private async linkWrites(
    groupId: string,
    playerId: string,
    slip: { lineUserId: string; displayName: string | null; pictureUrl: string | null }
  ): Promise<Prisma.PrismaPromise<unknown>[]> {
    if (!(await this.prisma.player.findFirst({ where: { id: playerId, groupId }, select: { id: true } }))) {
      throw new ConflictException({ code: 'PLAYER_NOT_IN_GROUP' });
    }
    const byAccount = await this.prisma.playerLineAccount.findUnique({
      where: { groupId_lineUserId: { groupId, lineUserId: slip.lineUserId } },
    });
    if (byAccount && byAccount.playerId !== playerId) throw new ConflictException({ code: 'ACCOUNT_ALREADY_LINKED' });
    await this.lineAccounts.touch(
      groupId,
      { lineUserId: slip.lineUserId, displayName: slip.displayName, pictureUrl: slip.pictureUrl },
      'host'
    );
    // Already this player's account: only the label changes; the link's age stays.
    if (byAccount) return [this.prisma.playerLineAccount.update({ where: { id: byAccount.id }, data: { linkedBy: 'host' } })];
    return [
      this.prisma.playerLineAccount.deleteMany({ where: { groupId, playerId } }),
      this.prisma.playerLineAccount.create({ data: { groupId, playerId, lineUserId: slip.lineUserId, linkedBy: 'host' } }),
    ];
  }

  async collection(code: string): Promise<{closedAt: string | null; canClose: boolean; imageCount: number}> {
    const session = await this.prisma.session.findUnique({ where: { code }, select: { paymentCollectionClosedAt: true } });
    if (!session) throw new NotFoundException();
    const panel = await this.cards.panel(code);
    const paid = await this.paidIds(code);
    const pending = await this.prisma.pendingSlip.count({ where: { sessionId: code, resolvedAt: null } });
    const duplicates = await this.prisma.slipDuplicate.count({ where: { sessionId: code, dismissedAt: null } });
    const payable = panel.rows.filter((r) => r.amountSatang > 0);
    return {
      closedAt: session.paymentCollectionClosedAt?.toISOString() ?? null,
      canClose: !session.paymentCollectionClosedAt && panel.ended && panel.confirmed && panel.ready && !panel.stale && payable.length > 0 && payable.every((r) => paid.has(r.playerId)) && pending === 0 && duplicates === 0,
      imageCount: await this.images.count(code),
    };
  }

  async closeCollection(code: string): Promise<void> {
    return this.lock.run(code, async () => {
      const state = await this.collection(code);
      if (!state.closedAt) {
        if (!state.canClose) throw new ConflictException({ code: 'COLLECTION_NOT_READY' });
        await this.prisma.session.update({ where: { code }, data: { paymentCollectionClosedAt: new Date() } });
      }
      // A failed file deletion is retried by the same action; the closed state blocks concurrent uploads meanwhile.
      await this.images.purgeSession(code);
    });
  }

  private async assertOpen(code: string): Promise<void> {
    const session = await this.prisma.session.findUnique({ where: { code }, select: { paymentCollectionClosedAt: true } });
    if (!session) throw new NotFoundException();
    if (session.paymentCollectionClosedAt) throw new ConflictException({ code: 'COLLECTION_CLOSED' });
  }

  private async groupOf(code: string): Promise<string> {
    const session = await this.prisma.session.findUnique({ where: { code }, select: { groupId: true } });
    if (!session) throw new NotFoundException();
    return session.groupId;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function parseIds(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
