import { createHash, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { LineClient } from '../line/line-client.js';
import { lineConfig } from '../line/line-config.js';
import { cardTexts, clip, TEXT_MAX } from '../line/line-summary-card.js';
import { LineSummaryService, type LineSummaryTarget } from '../line/line-summary.service.js';
import { liffPayUrl, paymentCardMessages, type PaymentCardInput } from '../line/payment-card.js';
import { PrismaService } from '../prisma/prisma.service.js';
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
  /** The bill's own copy gate (`readyToCopy`): false while an amount is undefined. */
  ready: boolean;
  warnings: string[];
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
  state: PaymentCardState;
  /** The LINE id the bot would push to; null when there is no destination. */
  to: string | null;
  cardInput: (account: PayAccount) => PaymentCardInput;
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

/** sha256 over the card's whole content in a fixed key order; player ids too, so two same-named rows cannot swap amounts unseen. */
function contentHash(input: PaymentCardInput, rows: PaymentPanel['rows']): string {
  const canonical = JSON.stringify({
    groupName: input.groupName,
    date: input.date,
    endedAt: input.endedAt.toISOString(),
    venue: input.venue,
    rows: rows.map((r) => [r.playerId, r.name, r.amountSatang, r.absent]),
    settledCount: input.settledCount,
    totalSatang: input.totalSatang,
    account: [input.account.bank, input.account.number, input.account.name],
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Hashing first gives timingSafeEqual the equal-length buffers it needs, with no length check that returns early. */
function sameToken(given: string, stored: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(stored));
}

function sentRecently(lastSentAt: string | null, now: Date): boolean {
  if (lastSentAt === null) return false;
  // A malformed timestamp is NaN and fails both comparisons: never busy.
  const age = now.getTime() - Date.parse(lastSentAt);
  return age >= 0 && age < BUSY_MS;
}

/**
 * The payment card (ใบเก็บเงิน): per-person amounts and an account, confirmed by the host, then posted by the bot
 * (`group` target) or shared on by the host through a token link (`host` target). Lives in the sessions module
 * because it reads the bill; LineModule must not import SessionsModule.
 */
@Injectable()
export class PaymentCardService {
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
   * Every confirm makes a new share token: an older link stops working, and the last of two racing confirms wins.
   */
  confirm(code: string, dto: ConfirmPaymentCardDto, now: Date = new Date()): Promise<PaymentPanel> {
    return this.lock.run(code, async () => {
      const checked = validatePayAccount(dto);
      if (!checked.ok) throw new BadRequestException({ code: 'PAY_ACCOUNT_INVALID' });
      const { panel, state, cardInput } = await this.view(code, now);
      if (panel.target === null) throw new ConflictException({ code: 'PAYMENT_UNAVAILABLE' });
      if (!panel.ended || !panel.ready || panel.rows.length === 0) {
        throw new ConflictException({ code: 'PAYMENT_NOT_READY' });
      }
      const account = checked.value ?? panel.account;
      if (account === null) throw new ConflictException({ code: 'PAYMENT_NO_ACCOUNT' });
      const confirmed: PaymentCardState = {
        account,
        token: newShareToken(),
        confirmedAt: now.toISOString(),
        confirmedHash: contentHash(cardInput(account), panel.rows),
        lastSentAt: state.lastSentAt,
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
      const { panel, state, to, cardInput } = await this.view(code, now);
      if (panel.target !== 'group' || to === null || !panel.ended) return 'unavailable';
      if (!panel.confirmed || panel.account === null) return 'not-confirmed';
      if (panel.stale) return 'stale';
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
      await this.prisma.session.update({ where: { code }, data: { paymentCard: serializePaymentState(sent) } });
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

    const { panel, cardInput } = await this.view(code, now);
    // The same gate as the link the host was shown: no link, no card.
    if (panel.shareUrl === null || panel.account === null) throw new NotFoundException();
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
    const cardInput = (payTo: PayAccount): PaymentCardInput => ({
      groupName: session.group.name,
      date: session.date,
      // Only an ended session is ever confirmed or sent; an open one's hash is never compared.
      endedAt: session.endedAt ?? now,
      venue: session.venue,
      rows: rows.map(({ name, amountSatang, absent }) => ({ name, amountSatang, absent })),
      settledCount,
      totalSatang,
      account: payTo,
    });

    // A state missing any part of a confirm (malformed or half-written) reads as never confirmed.
    const confirmed =
      state.account !== null && state.token !== null && state.confirmedAt !== null && state.confirmedHash !== null;
    const stale =
      confirmed &&
      (account === null || rows.length === 0 || contentHash(cardInput(account), rows) !== state.confirmedHash);
    const ended = session.endedAt !== null;
    const { liffId, publicAppUrl } = lineConfig();
    const shareUrl =
      destination?.target === 'host' &&
      ended &&
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
        ready: bill.readyToCopy,
        warnings: bill.result.warnings,
        rows,
        settledCount,
        totalSatang,
        groupAccount,
        account,
        confirmed,
        stale,
        lastSentAt: state.lastSentAt,
        shareUrl,
      },
      state,
      to: destination?.to ?? null,
      cardInput,
    };
  }
}
