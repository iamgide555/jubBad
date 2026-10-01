import type { CheckoutPreview, CheckoutReceipt, CheckoutModel } from './checkout.model';

/**
 * One-person LINE text for an early leaver. Always Thai whatever the host's UI
 * locale, since it is pasted to the player. A quote says so and promises
 * nothing; only a saved receipt says the amount is settled.
 */
const baht = (satang: number): string => {
  const whole = Math.trunc(satang / 100);
  const cents = satang % 100;
  return cents === 0 ? `${whole}` : `${whole}.${String(cents).padStart(2, '0')}`;
};

const MODEL_TH: Record<CheckoutModel, string> = {
  perGame: 'คิดต่อเกม',
  perShuttle: 'ตามลูกแบด',
  buffet: 'บุฟเฟ่ต์',
};

export function buildCheckoutText(source: CheckoutPreview | CheckoutReceipt, playerName: string): string {
  const settled = 'id' in source;
  const b = source.breakdown;
  const lines = [settled ? `สรุปยอด ${playerName} (เช็คเอาต์แล้ว)` : `ยอดโดยประมาณ ${playerName} (ยังไม่ได้ชำระ)`, `แบบ: ${MODEL_TH[source.model]}`];
  if ('games' in source) lines.push(`เล่น ${source.games} เกม`);
  if (source.model === 'perShuttle') {
    if (b.baseSatang > 0) lines.push(`ค่าเริ่มต้น ${baht(b.baseSatang)} บาท`);
    lines.push(`ค่าลูกแบด ${baht(b.shuttleSatang)} บาท`);
  } else {
    lines.push(`${source.model === 'buffet' ? 'ค่าบุฟเฟ่ต์' : 'ค่าเล่น'} ${baht(b.baseSatang)} บาท`);
    if (b.shuttleSatang > 0) lines.push(`ค่าลูกแบด ${baht(b.shuttleSatang)} บาท`);
  }
  if (b.hostFeeSatang > 0) lines.push(`ค่าดูแล ${baht(b.hostFeeSatang)} บาท`);
  if (b.walkInFeeSatang > 0) lines.push(`ค่าคนนอกรายชื่อ ${baht(b.walkInFeeSatang)} บาท`);
  lines.push(`รวม ${baht(source.amountSatang)} บาท`);
  if (!settled) lines.push('(ยอดอาจเปลี่ยนจนกว่าจะยืนยัน)');
  return lines.join('\n');
}
