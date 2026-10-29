import { copyableNumber, type PayAccount } from '../sessions/pay-account.js';
import { cardTexts, clip, COURT, INK, INK_SOFT } from './line-summary-card.js';

export interface PaymentCardInput {
  groupName: string | null;
  /** The session's own date text from the roster header, as the summary card shows it. */
  date: string | null;
  endedAt: Date;
  venue: string | null;
  /** One entry per person, in the bill's own order (the same order as the copied text). */
  rows: { name: string; amountSatang: number; absent: boolean }[];
  settledCount: number;
  totalSatang: number;
  account: PayAccount;
}

/**
 * Whether the card is followed by a second plain-text message holding the digits-only account number.
 * True is the safe fallback while the clipboard button is unconfirmed on a given path: the number can
 * always be long-pressed and copied from a text message. A later change flips the flags.
 */
export const PAYMENT_NUMBER_TEXT: { group: boolean; host: boolean } = {
  group: true,
  host: true,
};

const ALT_TEXT_MAX = 400;
/** Every host-typed text is clipped so one long entry cannot push the card past LINE's size limit. */
const TEXT_MAX = 60;

/** Satang as the web bill shows it: whole baht without decimals, otherwise two. Mirrors web bill-text.ts. */
export function formatBaht(satang: number): string {
  const sign = satang < 0 ? '-' : '';
  const abs = Math.abs(satang);
  const baht = Math.floor(abs / 100);
  const rest = abs % 100;
  const whole = String(baht).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (
    sign + (rest === 0 ? whole : `${whole}.${String(rest).padStart(2, '0')}`)
  );
}

/** The LIFF app's address for one session's pay page; the code is URL-encoded because LIFF carries it as a path segment. */
export function liffPayUrl(
  liffId: string,
  sessionCode: string,
  token: string,
): string {
  return `https://liff.line.me/${liffId}/pay/${encodeURIComponent(sessionCode)}/${encodeURIComponent(token)}`;
}

function infoRow(label: string, value: string) {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: INK_SOFT, flex: 2 },
      {
        type: 'text',
        text: value,
        size: 'sm',
        color: INK,
        flex: 5,
        wrap: true,
      },
    ],
  };
}

/** Name on the left, amount right-aligned; the name wraps and the amount never does. */
function amountRow(name: string, amount: string, bold = false) {
  const weight = bold ? { weight: 'bold' } : {};
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      {
        type: 'text',
        text: name,
        size: 'sm',
        color: INK,
        flex: 1,
        wrap: true,
        ...weight,
      },
      {
        type: 'text',
        text: amount,
        size: 'sm',
        color: INK,
        flex: 0,
        align: 'end',
        ...weight,
      },
    ],
  };
}

function personRow(person: PaymentCardInput['rows'][number]) {
  const name = clip(person.name, TEXT_MAX);
  const amount =
    person.amountSatang === 0
      ? 'ไม่ต้องโอน'
      : `฿${formatBaht(person.amountSatang)}`;
  return amountRow(person.absent ? `${name} (ไม่มา)` : name, amount);
}

function paymentCard(input: PaymentCardInput) {
  const { name, date, venue } = cardTexts(input);
  const account = {
    bank: clip(input.account.bank, TEXT_MAX),
    number: clip(input.account.number, TEXT_MAX),
    name: clip(input.account.name, TEXT_MAX),
  };

  const meta = [infoRow('วันที่', date)];
  if (venue) meta.push(infoRow('สนาม', venue));

  const body: unknown[] = [
    { type: 'box', layout: 'vertical', spacing: 'sm', contents: meta },
    { type: 'separator' },
    {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: input.rows.map(personRow),
    },
    { type: 'separator' },
    amountRow('รวม', `฿${formatBaht(input.totalSatang)}`, true),
  ];
  if (input.settledCount > 0) {
    body.push({
      type: 'text',
      text: `จ่ายแล้ว ${input.settledCount} คน`,
      size: 'sm',
      color: COURT,
    });
  }
  // The number is printed as text too, so a client that cannot run the clipboard action still shows it.
  body.push(
    { type: 'separator' },
    {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      contents: [
        {
          type: 'text',
          text: `โอนให้ ${account.name}`,
          size: 'sm',
          color: INK,
          wrap: true,
        },
        {
          type: 'text',
          text: account.bank,
          size: 'sm',
          color: INK_SOFT,
          wrap: true,
        },
        {
          type: 'text',
          text: account.number,
          size: 'lg',
          weight: 'bold',
          color: INK,
        },
      ],
    },
  );

  return {
    type: 'flex',
    altText: clip(`ยอดค่าเล่น ${name} ${date}`, ALT_TEXT_MAX),
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: COURT,
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: 'ยอดค่าเล่น', size: 'xs', color: '#e8f3ec' },
          {
            type: 'text',
            text: name,
            size: 'lg',
            weight: 'bold',
            color: '#ffffff',
            wrap: true,
          },
        ],
      },
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: body },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: COURT,
            action: {
              type: 'clipboard',
              label: 'คัดลอกเลขบัญชี',
              clipboardText: copyableNumber(input.account.number),
            },
          },
        ],
      },
    },
  };
}

/** The payment card, plus the plain-text account number after it where PAYMENT_NUMBER_TEXT asks for one. */
export function paymentCardMessages(
  input: PaymentCardInput,
  target: 'group' | 'host',
): unknown[] {
  const messages: unknown[] = [paymentCard(input)];
  if (PAYMENT_NUMBER_TEXT[target]) {
    messages.push({ type: 'text', text: copyableNumber(input.account.number) });
  }
  return messages;
}
