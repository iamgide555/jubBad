export interface SummaryCardInput {
  groupName: string | null;
  /** The session's own date text from the roster header, as the summary page shows it. */
  date: string | null;
  endedAt: Date;
  venue: string | null;
  players: number;
  games: number;
  url: string;
}

export interface SummaryCard {
  type: 'flex';
  altText: string;
  contents: Record<string, unknown>;
}

const GROUP_FALLBACK = 'ก๊วน';
const ALT_TEXT_MAX = 400;
// DESIGN.md: court (green) for the header and button, ink for text.
const COURT = '#1f6b3d';
const INK = '#16130f';
const INK_SOFT = '#6b6459';

/** Blank and whitespace-only read as missing: LINE rejects an empty text component. */
function present(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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

export function summaryCard(input: SummaryCardInput): SummaryCard {
  const name = present(input.groupName) ?? GROUP_FALLBACK;
  const date = cardDate(input.date, input.endedAt);
  const venue = present(input.venue);

  const rows = [row('วันที่', date)];
  if (venue) rows.push(row('สนาม', venue));
  rows.push(row('ผู้เล่น', `${input.players} คน`), row('เกม', `${input.games} เกม`));

  return {
    type: 'flex',
    altText: `สรุปก๊วน ${name} ${date}`.slice(0, ALT_TEXT_MAX),
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
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: COURT,
            action: { type: 'uri', label: 'ดูสรุป', uri: input.url },
          },
        ],
      },
    },
  };
}
