import { CollectorService } from './collector.service.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { LineClient } from '../line/line-client.js';
import { lineConfig } from '../line/line-config.js';
import { cardTexts, clip, TEXT_MAX } from '../line/line-summary-card.js';
import { LineSummaryService, type LineSummaryTarget } from '../line/line-summary.service.js';
import { liffPayUrl, liffSlipUrl, liffPaymentStatusUrl, paymentCardMessages, paymentDmMessages, type PaymentCardInput } from '../line/payment-card.js';
import { awardsDmMessages, awardsGroupMessages, rankAwards, type AwardsCardInput } from '../line/payment-awards-card.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { BillWarning } from '../../../engines/bill.ts';
import { BillService } from './bill.service.js';
import type { ConfirmPaymentCardDto } from './dto/confirm-payment-card.dto.js';
import { assertCollectorEligible } from '../groups/pay-collector.js';
import { parsePayAccount, sameReceivingAccount, validatePayAccount, type PayAccount } from './pay-account.js';
import {
  newShareToken,
  parsePaymentState,
  serializePaymentState,
  type PaymentCardState,
} from './payment-card-state.js';
import { SessionLock } from './session-lock.js';

/** `busy`: a card went out under 5 seconds ago (a double tap from a second tab), so this one was not posted. */
export type PaymentSendOutcome = 'sent' | 'quota' | 'failed' | 'unavailable' | 'not-confirmed' | 'stale' | 'busy';

/**
 * What the automatic awards card did on ปิดการเก็บเงิน. `skipped` is the host's choice (the close dialog's tick);
 * `unavailable` is nothing to send or nowhere to send it; `already-sent` is a repeat close after the card went out.
 */
export type AwardsSendOutcome = 'sent' | 'already-sent' | 'unavailable' | 'failed' | 'skipped';

/** Where an awards card would go when the collection closes, for the close dialog's wording; null when it would not send. */
export type AwardsDestination = 'group' | 'host' | null;

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
  /**
   * The card's header texts exactly as the card prints them (`cardTexts`: group-name fallback, Thai date,
   * clipped), so the panel's preview reads the same as the card the group receives.
   */
  groupName: string;
  date: string;
  venue: string | null;
  /** People still due, sorted by name (Thai collation, then player id): the card's order too. */
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
  /** Collection is closed (ปิดการเก็บเงิน): payments are frozen, so the awards card applies. */
  closed: boolean;
  groupId: string;
  /** The card's header fields, which the awards card prints too. */
  header: Pick<PaymentCardInput, 'groupName' | 'date' | 'endedAt' | 'venue'>;
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

/** One key per session for the awards card: LINE drops a repeat of the same push, so a close retried after a lost answer never posts twice. */
export function awardsRetryKey(sessionCode: string): string {
  const h = createHash('sha1').update(`jubbad-line-awards:${sessionCode}`).digest('hex');
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
    private readonly lock: SessionLock,
    private readonly collectors: CollectorService
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
      const closed = await this.prisma.session.findUnique({where:{code},select:{paymentCollectionClosedAt:true,groupId:true}});
      if (closed?.paymentCollectionClosedAt) throw new ConflictException({code:'COLLECTION_CLOSED'});
      const checked = validatePayAccount(dto);
      if (!checked.ok) throw new BadRequestException({ code: 'PAY_ACCOUNT_INVALID' });
      const { panel, nothingDue, state, cardInput } = await this.view(code, now);
      if (panel.target === null) throw new ConflictException({ code: 'PAYMENT_UNAVAILABLE' });
      if (!panel.ended || !panel.ready) throw new ConflictException({ code: 'PAYMENT_NOT_READY' });
      if (nothingDue) throw new ConflictException({ code: 'PAYMENT_NOTHING_DUE' });
      if (dto.expectedHash !== panel.contentHash) throw new ConflictException({ code: 'PAYMENT_CHANGED' });
      const account = checked.value ?? panel.account;
      if (account === null) throw new ConflictException({ code: 'PAYMENT_NO_ACCOUNT' });
      // A card on the group's own account belongs to the group's collector (resolved live), so no night one is kept.
      // Another account needs its own, who must be a player here with a LINE link. Checked before the write, still
      // under the lock, so a refusal leaves the earlier card as it was.
      // The pick is pinned to the LINE account linked right now, so a later link of another LINE account to the
      // same player does not inherit it (see CollectorService).
      let collectorPlayerId: string | null = null;
      let collectorLineUserId: string | null = null;
      if (!sameReceivingAccount(account, panel.groupAccount) && typeof dto.collectorPlayerId === 'string') {
        // `closed` was read from this same session a moment ago, so it is non-null once the view succeeded.
        collectorLineUserId = await assertCollectorEligible(this.prisma, closed!.groupId, dto.collectorPlayerId);
        collectorPlayerId = dto.collectorPlayerId;
      }
      const confirmed: PaymentCardState = {
        account,
        token: newShareToken(),
        confirmedAt: now.toISOString(),
        confirmedHash: contentHash(cardInput(account), panel.rows),
        lastSentAt: state.lastSentAt,
        lastDmAt: state.lastDmAt,
        collectorPlayerId,
        collectorLineUserId,
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
      const v = await this.view(code, now);
      const { panel, nothingDue, state, to, cardInput } = v;
      if (panel.target !== 'group' || to === null || !panel.ended) return 'unavailable';
      if (!panel.confirmed || panel.account === null) return 'not-confirmed';
      // An amount undefined since the confirm: the card on file no longer stands, as with a bill edit. Before
      // the nothing-due check, because a missing input reads as 0 and can make the provisional total 0.
      if (panel.stale || !panel.ready) return 'stale';
      if (nothingDue) return 'unavailable';
      if (sentRecently(state.lastSentAt, now)) return 'busy';

      let outcome: Awaited<ReturnType<LineClient['push']>>;
      try {
        // The send-slip button rides on the card only when the pay page can work (the LIFF app, and the LINE Login
        // channel it verifies players against) and the confirmed token exists; it is never part of the content hash
        // or the retry key, so a missing one just means no button.
        const { liffId, loginChannelId } = lineConfig();
        const slipUrl =
          liffId !== null && loginChannelId !== null && state.token ? liffSlipUrl(liffId, code, state.token) : null;
        const statusUrl = slipUrl && liffId && state.token ? liffPaymentStatusUrl(liffId, code, state.token) : null;
        // Once collection is closed the card members get is the awards card (payments are frozen, so it is final).
        const awards = await this.awardsInput(code, v);
        const messages =
          awards !== null
            ? awardsGroupMessages(awards, lineConfig().publicAppUrl, statusUrl)
            : paymentCardMessages(await this.memberCardInput(code, panel, cardInput(panel.account)), 'group', slipUrl, statusUrl);
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
      const v = await this.view(code, now);
      const { panel, nothingDue, state, to, cardInput } = v;
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
        const awards = await this.awardsInput(code, v);
        const messages =
          awards !== null
            ? awardsDmMessages(awards, lineConfig().publicAppUrl, shareUrl)
            : paymentDmMessages(await this.memberCardInput(code, panel, cardInput(panel.account)), shareUrl);
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
    const { liffId, publicAppUrl, loginChannelId } = lineConfig();
    if (liffId === null || publicAppUrl === null || !token) throw new NotFoundException();
    const session = await this.prisma.session.findUnique({
      where: { code },
      select: { endedAt: true, paymentCard: true },
    });
    if (!session || session.endedAt === null) throw new NotFoundException();
    const stored = parsePaymentState(session.paymentCard).token;
    if (stored === null || !sameToken(token, stored)) throw new NotFoundException();

    const v = await this.view(code, now);
    const { panel, nothingDue, cardInput } = v;
    // The same gate as the link the host was shown (no link, no card), with the send path's checks spelled out.
    if (panel.shareUrl === null || panel.account === null || !panel.ready || nothingDue) throw new NotFoundException();
    // Re-read on every open, so each share from the same DM button shows who still owes right now.
    const input = await this.memberCardInput(code, panel, cardInput(panel.account));
    const { name, date } = cardTexts(input);
    const statusUrl = loginChannelId === null ? null : liffPaymentStatusUrl(liffId, code, stored);
    // Closed collection: the share picker posts the awards card, the same one the bot would have sent.
    const awards = await this.awardsInput(code, v);
    return {
      liffId,
      // `stored` is the confirmed token the caller just matched, so the slip button carries exactly that one. No
      // button without the LINE Login channel: the pay page could not verify anyone.
      messages:
        awards !== null
          ? awardsGroupMessages(awards, publicAppUrl, statusUrl)
          : paymentCardMessages(input, 'host', loginChannelId === null ? null : liffSlipUrl(liffId, code, stored), statusUrl),
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

  /** A successful LINE share-picker callback, never a page-open or host-DM receipt. */
  async recordShare(code: string, token: string | undefined, now: Date = new Date()): Promise<void> {
    return this.lock.run(code, async () => {
      await this.shareCard(code, token, now);
      const session = await this.prisma.session.findUniqueOrThrow({where:{code},select:{paymentCard:true}});
      const state = parsePaymentState(session.paymentCard);
      // Retrying the acknowledgement must not pretend another card was sent.
      if (state.lastSentAt !== null) return;
      await this.prisma.session.update({where:{code},data:{paymentCard:serializePaymentState({...state,lastSentAt:now.toISOString()})}});
    });
  }

  /**
   * True only when the session's confirmed card holds exactly this token. A missing or empty token, an unknown
   * session and an unconfirmed card are all just false: callers decide what a refusal looks like.
   */
  async tokenValid(code: string, token: string | undefined): Promise<boolean> {
    if (!token) return false;
    const session = await this.prisma.session.findUnique({ where: { code }, select: { paymentCard: true } });
    if (!session) return false;
    const stored = parsePaymentState(session.paymentCard).token;
    return stored !== null && sameToken(token, stored);
  }

  /**
   * The awards card's content once collection is closed, or null when the ordinary payment card applies (open
   * collection, or nobody is rankable). Ranked are the billed people with a payment, minus the bill's
   * เจ้าของบัญชี (who receives the money) and the people who owe nothing; early checkouts are not billed rows, so
   * they are never ranked either. Everyone still counts toward "จ่ายครบแล้ว X คน".
   */
  private async awardsInput(code: string, v: PaymentView): Promise<AwardsCardInput | null> {
    if (!v.closed) return null;
    const payments = await this.prisma.sessionPayment.findMany({
      where: { sessionId: code },
      select: { playerId: true, createdAt: true, reference: true },
    });
    // A slip is timed by when it was sent, never by when the host approved it: the host picks the review order, and
    // that must not decide the podium. SlipReference is written at upload and never updated, and it outlives an undo
    // or a reject. A hand-made tick has no slip, so it keeps its own time (so does a reference swept by a group unlink).
    const references = payments.flatMap((p) => (p.reference === null ? [] : [p.reference]));
    const uploads = new Map(
      references.length === 0
        ? []
        : (
            await this.prisma.slipReference.findMany({
              where: { groupId: v.groupId, reference: { in: references } },
              select: { reference: true, createdAt: true },
            })
          ).map((r) => [r.reference, r.createdAt])
    );
    const paidAt = new Map(
      payments.map((p) => {
        const sent = p.reference === null ? undefined : uploads.get(p.reference);
        // Never later than the payment itself, as a safety net against a reference reused out of order.
        return [p.playerId, sent !== undefined && sent < p.createdAt ? sent : p.createdAt] as const;
      })
    );
    const owner = await this.collectors.forBill(code);
    const rankable = v.panel.rows.filter(
      (r) => r.amountSatang > 0 && r.playerId !== owner?.playerId && paidAt.has(r.playerId)
    );
    if (rankable.length === 0) return null;
    const links = await this.prisma.playerLineAccount.findMany({
      where: { groupId: v.groupId, playerId: { in: rankable.map((r) => r.playerId) } },
      select: { playerId: true, lineAccount: { select: { pictureUrl: true } } },
    });
    const picture = new Map(links.map((l) => [l.playerId, l.lineAccount.pictureUrl]));
    const view = rankAwards({
      paid: rankable.map((r) => ({
        playerId: r.playerId,
        name: r.name,
        pictureUrl: picture.get(r.playerId) ?? null,
        paidAt: paidAt.get(r.playerId)!,
      })),
      endedAt: v.header.endedAt,
      sessionCode: code,
      everyoneCount: v.panel.rows.length + v.panel.settledCount,
    });
    return view === null ? null : { ...v.header, view };
  }

  /**
   * Whether closing now would send an awards card, and where: what the close dialog words its tick by. Null when
   * there is no LINE destination or nobody is rankable. Open collection is judged as if closed, since the dialog
   * is asked before the close.
   */
  async awardsDestination(code: string, now: Date = new Date()): Promise<AwardsDestination> {
    const v = await this.view(code, now);
    if (v.to === null || !v.panel.ended || !v.panel.confirmed) return null;
    if (v.panel.target === 'host' && v.panel.shareUrl === null) return null;
    const probe: PaymentView = { ...v, closed: true };
    return (await this.awardsInput(code, probe)) === null ? null : v.panel.target;
  }

  /**
   * The automatic send on ปิดการเก็บเงิน: the awards card goes to the session's LINE destination, to the group
   * (`group` target) or as a DM to the host with ส่งเข้ากลุ่ม (`host` target). Once only: `awardsSentAt` is
   * recorded after LINE accepts, a repeat close finds it and does nothing, and a failed push leaves it unset so the
   * close can be retried (the retry key keeps LINE from posting twice). A failure here never undoes the close.
   * Not subject to the 60-second resend guard: it is its own once-only message.
   */
  sendAwards(code: string, now: Date = new Date()): Promise<AwardsSendOutcome> {
    return this.lock.run(code, async () => {
      const v = await this.view(code, now);
      const { panel, state, to } = v;
      if (!v.closed || to === null || panel.target === null || !panel.ended || !panel.confirmed) return 'unavailable';
      if (state.awardsSentAt) return 'already-sent';
      const shareUrl = panel.shareUrl;
      if (panel.target === 'host' && shareUrl === null) return 'unavailable';
      let outcome: Awaited<ReturnType<LineClient['push']>>;
      try {
        const awards = await this.awardsInput(code, v);
        if (awards === null) return 'unavailable';
        const { liffId, loginChannelId, publicAppUrl } = lineConfig();
        const statusUrl =
          liffId !== null && loginChannelId !== null && state.token ? liffPaymentStatusUrl(liffId, code, state.token) : null;
        const messages =
          panel.target === 'host'
            ? awardsDmMessages(awards, publicAppUrl, shareUrl as string)
            : awardsGroupMessages(awards, publicAppUrl, statusUrl);
        outcome = await this.line.push(to, messages, awardsRetryKey(code));
      } catch {
        return 'failed';
      }
      if (outcome !== 'ok') return 'failed';
      try {
        await this.prisma.session.update({
          where: { code },
          data: { paymentCard: serializePaymentState({ ...state, awardsSentAt: now.toISOString() }) },
        });
      } catch {
        // LINE already has the card; only the "sent" mark is lost, and the retry key makes a repeat harmless.
        this.logger.warn('awards card sent, but its send time could not be saved');
      }
      return 'sent';
    });
  }

  /**
   * The card as members see it: a player already paid (a matched slip or the host's mark, `SessionPayment`, or the
   * bill's เจ้าของบัญชี) is left
   * off and counted in "จ่ายแล้ว N คน", and the total is what is still owed. Read at every send and every share, and
   * kept out of the content hash on purpose: a payment is not a bill edit, so it must never make the confirmed card
   * stale and switch off the host's share link. `input.rows` is `panel.rows` without the ids, in the same order.
   */
  private async memberCardInput(code: string, panel: PaymentPanel, input: PaymentCardInput): Promise<PaymentCardInput> {
    const paid = new Set(
      (await this.prisma.sessionPayment.findMany({ where: { sessionId: code }, select: { playerId: true } })).map(
        (p) => p.playerId
      )
    );
    // The bill's เจ้าของบัญชี receives the money, so their own share is never owed (SlipPaymentsService.paidIds).
    const owner = await this.collectors.forBill(code);
    if (owner !== null) paid.add(owner.playerId);
    const unpaid = panel.rows.map((r) => !paid.has(r.playerId));
    const paidCount = unpaid.filter((u) => !u).length;
    if (paidCount === 0) return input;
    const rows = input.rows.filter((_, i) => unpaid[i]);
    return {
      ...input,
      rows,
      settledCount: input.settledCount + paidCount,
      totalSatang: rows.reduce((sum, r) => sum + r.amountSatang, 0),
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
        paymentCollectionClosedAt: true,
        groupId: true,
        group: { select: { name: true, payAccount: true } },
      },
    });
    if (!session) throw new NotFoundException();
    const bill = await this.bills.getBill(code);
    const destination = await this.summary.destination(code, now);

    // Still due only (removed and settled are not rows), sorted by name so a member finds their own line at a
    // glance; the player id breaks a tie between same-named people, so the order (and the hash) never moves.
    const billed = new Map(bill.result.rows.filter((r) => r.status === 'billed').map((r) => [r.playerId, r]));
    const rows = bill.players
      .flatMap((p) => {
        const row = billed.get(p.playerId);
        return row ? [{ playerId: p.playerId, name: p.name, amountSatang: row.amountSatang, absent: row.absent }] : [];
      })
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name, 'th') || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0)
      );
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
    const header = cardTexts(base);
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
        groupName: header.name,
        date: header.date,
        venue: header.venue,
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
      closed: session.paymentCollectionClosedAt !== null,
      groupId: session.groupId,
      header: { groupName: base.groupName, date: base.date, endedAt: base.endedAt, venue: base.venue },
    };
  }
}
