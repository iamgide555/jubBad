import { createHash, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { LineClient } from '../line/line-client.js';
import { lineConfig } from '../line/line-config.js';
import { cardTexts, clip, TEXT_MAX } from '../line/line-summary-card.js';
import { LineSummaryService, type LineSummaryTarget } from '../line/line-summary.service.js';
import { liffPayUrl, paymentCardMessages, paymentDmMessages, type PaymentCardInput } from '../line/payment-card.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { BillWarning } from '../../../engines/bill.ts';
import { BillService } from './bill.service.js';
import type { ConfirmPaymentCardDto } from './dto/confirm-payment-card.dto.js';
import { parsePayAccount, validatePayAccount, type PayAccount } from './pay-account.js';
import {
  newShareToken,
  parsePaymentState,
  serializePaymentState,
  type PaymentCardState,
} from './payment-card-state.js';
import { SessionLock } from './session-lock.js';

/** `busy`: a card went out under 5 seconds ago (a double tap from a second tab), so this one was not posted. */
export type PaymentSendOutcome = 'sent' | 'quota' | 'failed' | 'unavailable' | 'not-confirmed' | 'stale' | 'busy';

/** The bill screen's payment panel: exactly what the card would say, and where it stands. */
export interface PaymentPanel {
  /** Where the card goes, by the summary card's rule; null hides the panel. */
  target: LineSummaryTarget | null;
  ended: boolean;
  /** False while a blocking warning (an amount still undefined) is in `warnings`; notices never block. */
  ready: boolean;
  /**
   * sha256 over everything the card would print with the account shown here (the stale rule's hash). Not a
   * secret: confirm sends it back as `expectedHash`, so it freezes only the amounts the host actually saw.
   */
  contentHash: string;
  /** Every bill warning, blocking or not. */
  warnings: string[];
  /** The subset of `warnings` that only informs the host; the rest are the blocking ones. */
  notices: string[];
  /** People still due, in the bill's order. */
  rows: { playerId: string; name: string; amountSatang: number; absent: boolean }[];
  settledCount: number;
  totalSatang: number;
  groupAccount: PayAccount | null;
  /** Tonight's account if one was confirmed, else the group default. */
  account: PayAccount | null;
  confirmed: boolean;
  /** Confirmed, but the card's content has changed since: the host must confirm again before it goes out. */
  stale: boolean;
  lastSentAt: string | null;
  /** When the bot last DMed the card to the host (`host` target), null if never. */
  lastDmAt: string | null;
  /** The host-share link (`host` target only), set only while the confirmed card is current. */
  shareUrl: string | null;
}

/** What the public LIFF page needs: the LIFF id, the messages to share, and a preview of who is asked for what. */
export interface PaymentShareCard {
  liffId: string;
  messages: unknown[];
  preview: { name: string; date: string; count: number; totalSatang: number; bank: string; accountName: string };
}

/** One read of everything the panel and both send paths need, so all three see the same rows. */
interface PaymentView {
  panel: PaymentPanel;
  /** Nobody is listed, or everyone listed owes 0: there is nothing to collect, so no card. */
  nothingDue: boolean;
  state: PaymentCardState;
  /** The LINE id the bot would push to; null when there is no destination. */
  to: string | null;
  cardInput: (account: PayAccount) => PaymentCardInput;
}

/**
 * Warnings that only inform the host: the amounts are well defined on such a night, so the card may still go out.
 * Listed as the exceptions rather than listing the blocking ones, so a warning the engine adds later blocks
 * until someone decides otherwise. This differs on purpose from the bill's `readyToCopy`, which blocks on any warning.
 */
const NOTICES: ReadonlySet<string> = new Set<BillWarning>(['EXCESS_CREDIT', 'UNCOVERED_COST', 'UNRETURNED_SURCHARGE']);

/** Every amount is defined: no warning outside the informational NOTICES. A code not listed there blocks. */
export function isReady(warnings: readonly string[]): boolean {
  return warnings.every((w) => NOTICES.has(w));
}

/** Long enough to swallow a double tap from two tabs, short enough that a deliberate resend is never blocked. */
const BUSY_MS = 5_000;

/**
 * The same UUID-shaped sha1 construction as the summary card's retryKeyFor, over a different input, so the two
 * cards can never share a key. One key per tap of Send: a network retry of that tap is dropped by LINE, while a
 * deliberate resend (a new sendId) goes out.
 */
export function paymentRetryKey(sessionCode: string, sendId: string): string {
  const h = createHash('sha1').update(`jubbad-line-payment:${sessionCode}:${sendId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The host-DM counterpart of paymentRetryKey, over its own input (`:dm:`), so a DM and a group send of the same
 * sendId can never share a key either.
 */
export function paymentDmRetryKey(sessionCode: string, sendId: string): string {
  const h = createHash('sha1').update(`jubbad-line-payment:dm:${sessionCode}:${sendId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * sha256 over the card's whole content in a fixed key order; player ids too, so two same-named rows cannot swap
 * amounts unseen. A null account hashes as null (the panel before any account exists); for a real account the
 * canonical form is unchanged, so hashes stored by earlier confirms still compare.
 */
function contentHash(
  input: Omit<PaymentCardInput, 'account'> & { account: PayAccount | null },
  rows: PaymentPanel['rows']
): string {
  const canonical = JSON.stringify({
    groupName: input.groupName,
    date: input.date,
    endedAt: input.endedAt.toISOString(),
    venue: input.venue,
    rows: rows.map((r) => [r.playerId, r.name, r.amountSatang, r.absent]),
    settledCount: input.settledCount,
    totalSatang: input.totalSatang,
    account: input.account && [input.account.bank, input.account.number, input.account.name],
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Hashing first gives timingSafeEqual the equal-length buffers it needs, with no length check that returns early. */
function sameToken(given: string, stored: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(stored));
}

function sentRecently(lastAt: string | null, now: Date): boolean {
  if (lastAt === null) return false;
  // A malformed timestamp is NaN and fails both comparisons: never busy.
  const age = now.getTime() - Date.parse(lastAt);
  return age >= 0 && age < BUSY_MS;
}

/**
 * The payment card (ใบเก็บเงิน): per-person amounts and an account, confirmed by the host, then posted by the bot
 * (`group` target) or shared on by the host through a token link (`host` target). Lives in the sessions module
 * because it reads the bill; LineModule must not import SessionsModule.
 */
@Injectable()
export class PaymentCardService {
  private readonly logger = new Logger(PaymentCardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bills: BillService,
    private readonly summary: LineSummaryService,
    private readonly line: LineClient,
    private readonly lock: SessionLock
  ) {}

  async panel(code: string, now: Date = new Date()): Promise<PaymentPanel> {
    return (await this.view(code, now)).panel;
  }

  /**
   * Under the session lock, so a bill edit cannot land between the read the hash is taken from and the write.
   * Bound to what the host saw: `expectedHash` is the panel's `contentHash` from the read on their screen, and a
   * card that has moved since (another tab edited the bill) is refused with PAYMENT_CHANGED before anything is
   * stored. Every confirm makes a new share token: an older link stops working, and the last of two racing
   * confirms wins.
   */
  confirm(code: string, dto: ConfirmPaymentCardDto, now: Date = new Date()): Promise<PaymentPanel> {
    return this.lock.run(code, async () => {
      const checked = validatePayAccount(dto);
      if (!checked.ok) throw new BadRequestException({ code: 'PAY_ACCOUNT_INVALID' });
      const { panel, nothingDue, state, cardInput } = await this.view(code, now);
      if (panel.target === null) throw new ConflictException({ code: 'PAYMENT_UNAVAILABLE' });
      if (!panel.ended || !panel.ready) throw new ConflictException({ code: 'PAYMENT_NOT_READY' });
      if (nothingDue) throw new ConflictException({ code: 'PAYMENT_NOTHING_DUE' });
      if (dto.expectedHash !== panel.contentHash) throw new ConflictException({ code: 'PAYMENT_CHANGED' });
      const account = checked.value ?? panel.account;
      if (account === null) throw new ConflictException({ code: 'PAYMENT_NO_ACCOUNT' });
      const confirmed: PaymentCardState = {
        account,
        token: newShareToken(),
        confirmedAt: now.toISOString(),
        confirmedHash: contentHash(cardInput(account), panel.rows),
        lastSentAt: state.lastSentAt,
        lastDmAt: state.lastDmAt,
      };
      await this.prisma.session.update({ where: { code }, data: { paymentCard: serializePaymentState(confirmed) } });
      return (await this.view(code, now)).panel;
    });
  }

  /**
   * The bot posts the confirmed card into the linked LINE group. Under the session lock, so a second tab's tap
   * waits for the first and then reads its `lastSentAt` (busy) instead of posting twice. Everything is re-read
   * here, so a lapsed plan, an unlinked group or a bill edited since the confirm sends nothing.
   */
  send(code: string, sendId: string, now: Date = new Date()): Promise<PaymentSendOutcome> {
    return this.lock.run(code, async () => {
      const { panel, nothingDue, state, to, cardInput } = await this.view(code, now);
      if (panel.target !== 'group' || to === null || !panel.ended) return 'unavailable';
      if (!panel.confirmed || panel.account === null) return 'not-confirmed';
      // An amount undefined since the confirm: the card on file no longer stands, as with a bill edit. Before
      // the nothing-due check, because a missing input reads as 0 and can make the provisional total 0.
      if (panel.stale || !panel.ready) return 'stale';
      if (nothingDue) return 'unavailable';
      if (sentRecently(state.lastSentAt, now)) return 'busy';

      let outcome: Awaited<ReturnType<LineClient['push']>>;
      try {
        const messages = paymentCardMessages(cardInput(panel.account), 'group');
        outcome = await this.line.push(to, messages, paymentRetryKey(code, sendId));
      } catch {
        return 'failed';
      }
      if (outcome !== 'ok') return outcome;
      const sent: PaymentCardState = { ...state, lastSentAt: now.toISOString() };
      try {
        await this.prisma.session.update({ where: { code }, data: { paymentCard: serializePaymentState(sent) } });
      } catch {
        // LINE already has the card, so the answer is still `sent`; only the panel's "ส่งแล้ว" time is lost.
        // Nothing from the error is logged: it can carry the stored state (account and token).
        this.logger.warn('payment card sent, but its send time could not be saved');
      }
      return 'sent';
    });
  }

  /**
   * The bot DMs the confirmed card to the host's own LINE chat (`host` target), with a "ส่งเข้ากลุ่ม" button that
   * opens the share link. Opt-in per tap, never automatic: one push to the host's DM per press. Mirrors `send`:
   * the same lock, one view, the same gate order and outcomes. `to` comes from the server-side link, never from
   * the request.
   */
  sendToHost(code: string, sendId: string, now: Date = new Date()): Promise<PaymentSendOutcome> {
    return this.lock.run(code, async () => {
      const { panel, nothingDue, state, to, cardInput } = await this.view(code, now);
      if (panel.target !== 'host' || to === null || !panel.ended) return 'unavailable';
      if (!panel.confirmed || panel.account === null) return 'not-confirmed';
      if (panel.stale || !panel.ready) return 'stale';
      if (nothingDue) return 'unavailable';
      // Set only for a confirmed, current, ready card with the LIFF id and public URL; without it the card has
      // no "ส่งเข้ากลุ่ม" target to carry.
      const shareUrl = panel.shareUrl;
      if (shareUrl === null) return 'unavailable';
      if (sentRecently(state.lastDmAt, now)) return 'busy';

      let outcome: Awaited<ReturnType<LineClient['push']>>;
      try {
        const messages = paymentDmMessages(cardInput(panel.account), shareUrl);
        outcome = await this.line.push(to, messages, paymentDmRetryKey(code, sendId));
      } catch {
        return 'failed';
      }
      if (outcome !== 'ok') return outcome;
      const sent: PaymentCardState = { ...state, lastDmAt: now.toISOString() };
      try {
        await this.prisma.session.update({ where: { code }, data: { paymentCard: serializePaymentState(sent) } });
      } catch {
        // LINE already has the card, so the answer is still `sent`; only the panel's "ส่งแล้ว" time is lost.
        // Nothing from the error is logged: it can carry the stored state (account and token).
        this.logger.warn('payment card DM sent, but its send time could not be saved');
      }
      return 'sent';
    });
  }

  /**
   * The public read behind the host-share link. A bearer link like the group dashboard's: it serves only the
   * card the panel's `shareUrl` points at (host target, ended, confirmed, unchanged since) to a caller holding the
   * current token. Every failure is the same NotFoundException, so nothing here says whether a session exists,
   * was confirmed, or had a different token.
   */
  async shareCard(code: string, token: string | undefined, now: Date = new Date()): Promise<PaymentShareCard> {
    // Config first: with the feature off, an anonymous caller must not cost a database lookup.
    const { liffId, publicAppUrl } = lineConfig();
    if (liffId === null || publicAppUrl === null || !token) throw new NotFoundException();
    const session = await this.prisma.session.findUnique({
      where: { code },
      select: { endedAt: true, paymentCard: true },
    });
    if (!session || session.endedAt === null) throw new NotFoundException();
    const stored = parsePaymentState(session.paymentCard).token;
    if (stored === null || !sameToken(token, stored)) throw new NotFoundException();

    const { panel, nothingDue, cardInput } = await this.view(code, now);
    // The same gate as the link the host was shown (no link, no card), with the send path's checks spelled out.
    if (panel.shareUrl === null || panel.account === null || !panel.ready || nothingDue) throw new NotFoundException();
    const input = cardInput(panel.account);
    const { name, date } = cardTexts(input);
    return {
      liffId,
      messages: paymentCardMessages(input, 'host'),
      preview: {
        name,
        date,
        count: input.rows.length,
        totalSatang: input.totalSatang,
        bank: clip(panel.account.bank, TEXT_MAX),
        accountName: clip(panel.account.name, TEXT_MAX),
      },
    };
  }

  /** One getBill, one destination read: the panel, the bot send and the share read all start here. */
  private async view(code: string, now: Date): Promise<PaymentView> {
    const session = await this.prisma.session.findUnique({
      where: { code },
      select: {
        date: true,
        venue: true,
        endedAt: true,
        paymentCard: true,
        group: { select: { name: true, payAccount: true } },
      },
    });
    if (!session) throw new NotFoundException();
    const bill = await this.bills.getBill(code);
    const destination = await this.summary.destination(code, now);

    // The bill's own order, as the copied text lists people: still due only (removed and settled are not rows).
    const billed = new Map(bill.result.rows.filter((r) => r.status === 'billed').map((r) => [r.playerId, r]));
    const rows = bill.players.flatMap((p) => {
      const row = billed.get(p.playerId);
      return row ? [{ playerId: p.playerId, name: p.name, amountSatang: row.amountSatang, absent: row.absent }] : [];
    });
    const totalSatang = rows.reduce((sum, r) => sum + r.amountSatang, 0);
    const settledCount = bill.settled.length;

    const state = parsePaymentState(session.paymentCard);
    const groupAccount = parsePayAccount(session.group.payAccount);
    const account = state.account ?? groupAccount;
    const base: Omit<PaymentCardInput, 'account'> = {
      groupName: session.group.name,
      date: session.date,
      // Only an ended session is ever confirmed or sent; an open one's hash moves with `now` and never matches.
      endedAt: session.endedAt ?? now,
      venue: session.venue,
      rows: rows.map(({ name, amountSatang, absent }) => ({ name, amountSatang, absent })),
      settledCount,
      totalSatang,
    };
    const cardInput = (payTo: PayAccount): PaymentCardInput => ({ ...base, account: payTo });
    const hash = contentHash({ ...base, account }, rows);

    // A state missing any part of a confirm (malformed or half-written) reads as never confirmed.
    const confirmed =
      state.account !== null && state.token !== null && state.confirmedAt !== null && state.confirmedHash !== null;
    const stale = confirmed && (account === null || rows.length === 0 || hash !== state.confirmedHash);
    const ended = session.endedAt !== null;
    const { warnings } = bill.result;
    const notices = warnings.filter((w) => NOTICES.has(w));
    const ready = isReady(warnings);
    const nothingDue = rows.length === 0 || totalSatang === 0;
    const { liffId, publicAppUrl } = lineConfig();
    const shareUrl =
      destination?.target === 'host' &&
      ended &&
      ready &&
      !nothingDue &&
      confirmed &&
      !stale &&
      state.token !== null &&
      liffId !== null &&
      publicAppUrl !== null
        ? liffPayUrl(liffId, code, state.token)
        : null;

    return {
      panel: {
        target: destination?.target ?? null,
        ended,
        ready,
        contentHash: hash,
        warnings,
        notices,
        rows,
        settledCount,
        totalSatang,
        groupAccount,
        account,
        confirmed,
        stale,
        lastSentAt: state.lastSentAt,
        lastDmAt: state.lastDmAt,
        shareUrl,
      },
      nothingDue,
      state,
      to: destination?.to ?? null,
      cardInput,
    };
  }
}
