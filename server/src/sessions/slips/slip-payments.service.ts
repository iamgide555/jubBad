import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { lineConfig } from '../../line/line-config.js';
import { cardDate } from '../../line/line-summary-card.js';
import { planAtLeast } from '../../plans/plan.js';
import { PlansService } from '../../plans/plans.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
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
  source: 'slip' | 'host';
  /** ISO time the mark was written. */
  at: string;
  /** A slip credited an amount that no longer matches the player's current bill row. The mark stays; the host decides. */
  amountChangedSince: boolean;
}

/** The LINE profile the pay page reads for the viewer. Only `userId` is required to link; the rest is for display. */
export interface LiffUser {
  userId: string;
  displayName: string | null;
  pictureUrl: string | null;
}

export type ClaimOutcome = 'linked' | 'player-taken' | 'account-already-linked' | 'not-on-bill';

export interface LinkRow {
  playerId: string;
  displayName: string | null;
  linkedBy: 'self' | 'host';
}

/** Why a slip was held for the host instead of marking anyone paid. */
export type WaitingReason = 'unmapped' | 'amount' | 'date' | 'receiver' | 'unreadable' | 'stale' | 'collision';

export type SubmitOutcome =
  | { kind: 'paid'; playerIds: string[] }
  | { kind: 'waiting'; reason: WaitingReason }
  | { kind: 'duplicate' }
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
  /** The night the bill is for, as the card writes it (a stored yyyy-mm-dd becomes a Thai date); null with no date. */
  sessionDate: string | null;
}

/** Read-only bill projection for collectors; never includes host review or LINE account data. */
export interface PaymentStatusView {
  closedAt: string | null;
  pendingSlipCount: number;
  sessionDate: string | null;
  rows: { name: string; amountSatang: number; paid: boolean; pending: boolean; amountChangedSince: boolean }[];
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
    private readonly images: SlipImagesService
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
      sessionDate: date === null || date.trim() === '' ? null : cardDate(date, billEnd),
    };
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

  async paymentStatusView(code: string, token: string | undefined, now: Date = new Date()): Promise<PaymentStatusView | null> {
    return this.lock.run(code, async () => {
      const gate = await this.gate(code, token, now);
      if (!gate) return null;
      const stored = await this.prisma.sessionPayment.findMany({ where: { sessionId: code } });
      const paid = new Map(stored.map((p) => [p.playerId, p]));
      const pending = await this.prisma.pendingSlip.findMany({ where: { sessionId: code, resolvedAt: null } });
      const links = await this.prisma.playerLineAccount.findMany({ where: { groupId: gate.groupId } });
      const linked = new Map(links.map((l) => [l.lineUserId, l.playerId]));
      return {
        closedAt: gate.closedAt?.toISOString() ?? null,
        pendingSlipCount: pending.length,
        sessionDate: gate.date === null || gate.date.trim() === '' ? null : cardDate(gate.date, gate.billEnd),
        rows: gate.panel.rows.map((r) => {
          const mark = paid.get(r.playerId);
          return {
            name: r.name, amountSatang: r.amountSatang, paid: mark !== undefined,
            pending: !mark && pending.some((p) => linked.get(p.lineUserId) === r.playerId && p.amountSatang === r.amountSatang),
            amountChangedSince: mark !== undefined && mark.amountSatang !== null && mark.amountSatang !== r.amountSatang,
          };
        }),
      };
    });
  }

  async getPaid(code: string): Promise<PaidRow[]> {
    const panel = await this.cards.panel(code);
    const current = new Map(panel.rows.map((r) => [r.playerId, r.amountSatang]));
    const stored = await this.prisma.sessionPayment.findMany({ where: { sessionId: code }, orderBy: { createdAt: 'asc' } });
    return stored.map((p) => ({
      playerId: p.playerId,
      source: p.source === 'slip' ? 'slip' : 'host',
      at: p.createdAt.toISOString(),
      amountChangedSince: p.amountSatang !== null && p.amountSatang !== current.get(p.playerId),
    }));
  }

  /** The host marks a person paid. Already paid (by a slip or an earlier tick) stays as it is. */
  tick(code: string, playerId: string): Promise<void> {
    return this.lock.run(code, async () => {
      await this.assertOpen(code);
      const panel = await this.cards.panel(code);
      if (!panel.rows.some((r) => r.playerId === playerId)) throw new ConflictException({ code: 'PLAYER_NOT_ON_BILL' });
      await this.prisma.sessionPayment.upsert({
        where: { sessionId_playerId: { sessionId: code, playerId } },
        create: { sessionId: code, playerId, source: 'host' },
        update: {},
      });
    });
  }

  /** Removes the paid mark if there is one. The slip's reference is deliberately left alone by this task. */
  untick(code: string, playerId: string): Promise<void> {
    return this.lock.run(code, async () => {
      await this.assertOpen(code);
      await this.cards.panel(code);
      await this.prisma.sessionPayment.deleteMany({ where: { sessionId: code, playerId } });
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
      try {
        await this.prisma.playerLineAccount.create({
          data: { groupId, playerId, lineUserId: user.userId, displayName: user.displayName, linkedBy: 'self' },
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

  /** The player this LINE account is linked to in the group, if any. */
  async linkedPlayerOf(groupCode: string, lineUserId: string): Promise<string | null> {
    const link = await this.prisma.playerLineAccount.findUnique({
      where: { groupId_lineUserId: { groupId: groupCode, lineUserId } },
      select: { playerId: true },
    });
    return link?.playerId ?? null;
  }

  /** Every link in the session's group, oldest first. */
  async listLinks(code: string): Promise<LinkRow[]> {
    const groupId = await this.groupOf(code);
    const links = await this.prisma.playerLineAccount.findMany({ where: { groupId }, orderBy: { createdAt: 'asc' } });
    return links.map((l) => ({
      playerId: l.playerId,
      displayName: l.displayName,
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
      try {
        if (byAccount) {
          // Already this player's account: only the label changes; the stored name and age stay.
          await this.prisma.playerLineAccount.update({ where: { id: byAccount.id }, data: { linkedBy: 'host' } });
          return;
        }
        await this.prisma.$transaction([
          this.prisma.playerLineAccount.deleteMany({ where: { groupId, playerId } }),
          this.prisma.playerLineAccount.create({
            data: { groupId, playerId, lineUserId, displayName: null, linkedBy: 'host' },
          }),
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
    return rows.map((s) => ({
      id: s.id,
      imageId: imageByReference.get(s.reference) ?? null,
      linkedPlayerId: linked.get(s.lineUserId) ?? null,
      reason: s.reason as WaitingReason,
      displayName: s.displayName,
      pictureUrl: s.pictureUrl,
      lineUserId: s.lineUserId,
      amountSatang: s.amountSatang,
      receiverName: s.receiverName,
      receiverTail: s.receiverTail,
      createdAt: s.createdAt.toISOString(),
      // Nobody owing nothing is ever a match for an amount.
      candidatePlayerIds: unpaid
        .filter((r) => (s.amountSatang === null ? true : r.amountSatang > 0 && r.amountSatang === s.amountSatang))
        .map((r) => r.playerId),
    }));
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

  /** Host: nothing to credit for this slip. It leaves the list; no one is marked paid. */
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
    const paid = new Set(
      (await this.prisma.sessionPayment.findMany({ where: { sessionId: code }, select: { playerId: true } })).map(
        (p) => p.playerId
      )
    );
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
    return { kind: 'waiting', reason };
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
    if (!amountPresent(ocr.text, row.amountSatang)) return hasAmountToken(ocr.text) ? 'amount' : 'unreadable';
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

  /** The player ids that currently count as paid in the session. */
  private async paidIds(code: string): Promise<Set<string>> {
    const rows = await this.prisma.sessionPayment.findMany({ where: { sessionId: code }, select: { playerId: true } });
    return new Set(rows.map((p) => p.playerId));
  }

  /**
   * The writes that make the slip's account this player's (the rules of `setLink`, labelled as the host's), or a thrown
   * refusal. Nothing is written here.
   */
  private async linkWrites(
    groupId: string,
    playerId: string,
    slip: { lineUserId: string; displayName: string | null }
  ): Promise<Prisma.PrismaPromise<unknown>[]> {
    if (!(await this.prisma.player.findFirst({ where: { id: playerId, groupId }, select: { id: true } }))) {
      throw new ConflictException({ code: 'PLAYER_NOT_IN_GROUP' });
    }
    const byAccount = await this.prisma.playerLineAccount.findUnique({
      where: { groupId_lineUserId: { groupId, lineUserId: slip.lineUserId } },
    });
    if (byAccount && byAccount.playerId !== playerId) throw new ConflictException({ code: 'ACCOUNT_ALREADY_LINKED' });
    // Already this player's account: only the label changes; the stored name stays.
    if (byAccount) return [this.prisma.playerLineAccount.update({ where: { id: byAccount.id }, data: { linkedBy: 'host' } })];
    return [
      this.prisma.playerLineAccount.deleteMany({ where: { groupId, playerId } }),
      this.prisma.playerLineAccount.create({
        data: { groupId, playerId, lineUserId: slip.lineUserId, displayName: slip.displayName, linkedBy: 'host' },
      }),
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
