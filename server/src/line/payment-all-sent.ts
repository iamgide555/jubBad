import { ALT_TEXT_MAX, clip, COURT, HEADER_LABEL, HEADER_TITLE, INK, INK_SOFT } from './line-summary-card.js';

export interface AllSentInput {
  /** Already clipped and defaulted (`cardTexts(...).name`). */
  groupName: string;
  /** Already written as a Thai date (`cardTexts(...).date`). */
  date: string;
  /** Slips still waiting for the host's review; 0 means nothing is left to review. */
  waitingCount: number;
  /** The payment-status page the button opens, where slips are reviewed and collection is closed. */
  statusUrl: string;
}

/**
 * The one message the bot sends when every person who owes has paid or has a slip waiting: to the host and to the
 * bill's เจ้าของบัญชี, never to the group. One bubble, one button. The line under the title says whether anything is
 * still waiting, so a host reads at a glance whether to review or just close.
 */
export function allSentMessages(input: AllSentInput): unknown[] {
  const waiting = input.waitingCount > 0;
  const title = waiting ? 'ทุกคนส่งสลิปครบแล้ว' : 'ทุกคนจ่ายครบแล้ว';
  const detail = waiting
    ? `มีสลิปรอตรวจ ${input.waitingCount} ใบ กรุณาตรวจสอบ`
    : 'กรุณาตรวจสอบ แล้วปิดการเก็บเงิน';
  return [
    {
      type: 'flex',
      altText: clip(`${title} ${input.groupName} ${input.date} · ${detail}`, ALT_TEXT_MAX),
      contents: {
        type: 'bubble',
        header: {
          type: 'box',
          layout: 'vertical',
          backgroundColor: COURT,
          paddingAll: 'lg',
          contents: [
            { type: 'text', text: 'แจ้งเตือนการจ่ายเงิน', size: 'xs', color: HEADER_LABEL },
            { type: 'text', text: input.groupName, size: 'lg', weight: 'bold', color: HEADER_TITLE, wrap: true },
          ],
        },
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            { type: 'text', text: title, size: 'md', weight: 'bold', color: COURT, wrap: true },
            { type: 'text', text: detail, size: 'sm', color: INK, wrap: true },
            { type: 'text', text: input.date, size: 'xs', color: INK_SOFT },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: COURT,
              action: { type: 'uri', label: 'เปิดรายการจ่ายเงิน', uri: input.statusUrl },
            },
          ],
        },
      },
    },
  ];
}
