import { describe, expect, it } from 'vitest';
import { allSentMessages } from './payment-all-sent.js';

const BASE = { groupName: 'ตีชิล', date: '29 ต.ค. 2569', statusUrl: 'https://liff.line.me/L/payment-status/S1/T1' };

type Node = Record<string, unknown>;

function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (node !== null && typeof node === 'object') {
    const n = node as Node;
    if (n['type'] === 'text' && typeof n['text'] === 'string') out.push(n['text']);
    Object.values(n).forEach((v) => texts(v, out));
  }
  return out;
}

describe('allSentMessages', () => {
  it('is a single flex message', () => {
    const messages = allSentMessages({ ...BASE, waitingCount: 0 }) as Node[];
    expect(messages).toHaveLength(1);
    expect(messages[0]['type']).toBe('flex');
  });

  it('says everyone paid, and asks to close, when nothing is waiting', () => {
    const [card] = allSentMessages({ ...BASE, waitingCount: 0 }) as { altText: string }[];
    expect(card.altText).toContain('ทุกคนจ่ายครบแล้ว');
    expect(card.altText).toContain('ตีชิล');
    expect(texts(card)).toContain('กรุณาตรวจสอบ แล้วปิดการเก็บเงิน');
    expect(card.altText).not.toContain('รอตรวจ');
  });

  it('says everyone sent a slip and counts the ones waiting for review', () => {
    const [card] = allSentMessages({ ...BASE, waitingCount: 3 }) as { altText: string }[];
    expect(card.altText).toContain('ทุกคนส่งสลิปครบแล้ว');
    expect(texts(card)).toContain('มีสลิปรอตรวจ 3 ใบ กรุณาตรวจสอบ');
  });

  it('has one button that opens the payment-status page', () => {
    const [card] = allSentMessages({ ...BASE, waitingCount: 1 }) as { contents: Node }[];
    const footer = card.contents['footer'] as { contents: { action: Node }[] };
    expect(footer.contents).toHaveLength(1);
    expect(footer.contents[0].action).toEqual({
      type: 'uri',
      label: 'เปิดรายการจ่ายเงิน',
      uri: BASE.statusUrl,
    });
  });

  it('clips the alt text to the LINE limit', () => {
    const [card] = allSentMessages({ ...BASE, groupName: 'ก'.repeat(500), waitingCount: 0 }) as { altText: string }[];
    expect(Array.from(card.altText).length).toBeLessThanOrEqual(400);
  });
});
