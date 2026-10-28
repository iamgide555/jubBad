export interface SummaryCardInput {
  groupName: string | null;
  /** The session's own date text from the roster header, as the summary page shows it. */
  date: string | null;
  endedAt: Date;
  venue: string | null;
  players: number;
  games: number;
  url: string;
  /** The LIFF link behind the host's "send to group" button; leave out for the card posted in a group. */
  shareUrl?: string;
}

export interface SummaryCard {
  type: 'flex';
  altText: string;
  contents: Record<string, unknown>;
}

const GROUP_FALLBACK = 'ก๊วน';
const ALT_TEXT_MAX = 400;
/** Group name, venue and date are host-typed; clipped so one long entry cannot push the card past LINE's size limit. */
const TEXT_MAX = 60;
// DESIGN.md: court (green) for the header and button, ink for text.
const COURT = '#1f6b3d';
const INK = '#16130f';
const INK_SOFT = '#6b6459';

/** Blank and whitespace-only read as missing: LINE rejects an empty text component. */
function present(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Clips to `max` characters (code points, so an emoji is never cut in half), ending in an ellipsis when cut. */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

const THAI_DATE = new Intl.DateTimeFormat('th-TH', {
  timeZone: 'Asia/Bangkok',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/**
 * The session's date for the card. The app stores a yyyy-mm-dd date, which reads as raw digits in a chat, so
 * it is written as a Thai date; any other text is kept as written, and a missing date falls back to the day
 * the session ended, in Bangkok time.
 */
export function cardDate(date: string | null, endedAt: Date): string {
  const text = present(date);
  if (text === null) return THAI_DATE.format(endedAt);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const noonInBangkok = new Date(`${text}T12:00:00+07:00`);
    if (!Number.isNaN(noonInBangkok.getTime())) return THAI_DATE.format(noonInBangkok);
  }
  return text;
}

function row(label: string, value: string) {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: INK_SOFT, flex: 2 },
      { type: 'text', text: value, size: 'sm', color: INK, flex: 5, wrap: true },
    ],
  };
}

/** The LIFF app's address for one session; the code is URL-encoded because LIFF carries it as a path segment. */
export function liffShareUrl(liffId: string, sessionCode: string): string {
  return `https://liff.line.me/${liffId}/${encodeURIComponent(sessionCode)}`;
}

export function summaryCard(input: SummaryCardInput): SummaryCard {
  const name = clip(present(input.groupName) ?? GROUP_FALLBACK, TEXT_MAX);
  const date = clip(cardDate(input.date, input.endedAt), TEXT_MAX);
  const venueText = present(input.venue);
  const venue = venueText === null ? null : clip(venueText, TEXT_MAX);

  const rows = [row('วันที่', date)];
  if (venue) rows.push(row('สนาม', venue));
  rows.push(row('ผู้เล่น', `${input.players} คน`), row('เกม', `${input.games} เกม`));

  return {
    type: 'flex',
    altText: clip(`สรุปก๊วน ${name} ${date}`, ALT_TEXT_MAX),
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: COURT,
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: 'สรุปก๊วน', size: 'xs', color: '#e8f3ec' },
          { type: 'text', text: name, size: 'lg', weight: 'bold', color: '#ffffff', wrap: true },
        ],
      },
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: rows },
      footer: {
        type: 'box',
        layout: 'vertical',
        ...(input.shareUrl ? { spacing: 'sm' } : {}),
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: COURT,
            action: { type: 'uri', label: 'ดูสรุป', uri: input.url },
          },
          ...(input.shareUrl
            ? [
                {
                  type: 'button',
                  style: 'secondary',
                  action: { type: 'uri', label: 'ส่งเข้ากลุ่ม', uri: input.shareUrl },
                },
              ]
            : []),
        ],
      },
    },
  };
}
