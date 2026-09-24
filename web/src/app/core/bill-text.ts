import type { BillResponse } from './bill.model';

/**
 * 144000 -> "1,440"; 8550 -> "85.50"; -1500 -> "-15". Manual, so output never
 * depends on the runtime locale. Handles negatives (the margin line) correctly
 * regardless of Math.floor's toward-negative-infinity behavior.
 */
export function formatBaht(satang: number): string {
  const sign = satang < 0 ? '-' : '';
  const abs = Math.abs(satang);
  const baht = Math.floor(abs / 100);
  const rest = abs % 100;
  const whole = String(baht).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + (rest === 0 ? whole : `${whole}.${String(rest).padStart(2, '0')}`);
}

/** LINE group text. Always Thai regardless of UI locale (owner decision, C3). */
export function buildBillText(bill: BillResponse): string {
  const { session, config: c, result, players } = bill;
  const lines: string[] = [];
  lines.push(['💰 ค่าก๊วน', session.date, session.venue ? `— ${session.venue}` : null].filter(Boolean).join(' '));
  const shuttleLine = () => {
    if (session.shuttleCount === null || session.shuttlePriceSatang === null) return;
    const how = c.shuttleSplit === 'equal' ? 'หารเท่า' : 'ตามจำนวนเกม';
    lines.push(`ค่าลูก ${session.shuttleCount} ลูก × ${formatBaht(session.shuttlePriceSatang)}฿ ${how}`);
  };
  if (c.model === 'fair') {
    const court = formatBaht(c.courtFeeSatang ?? 0);
    lines.push(
      c.courtSplit === 'equal'
        ? `ค่าคอร์ท ${court}฿ หารเท่า ${result.totals.billedCount} คน`
        : `ค่าคอร์ท ${court}฿ ตามจำนวนเกม`
    );
    shuttleLine();
  } else if (c.model === 'perGame') {
    const extras = [
      c.entryFeeSatang > 0 ? `+ค่าเข้า ${formatBaht(c.entryFeeSatang)}฿` : null,
      c.capSatang !== null ? `สูงสุด ${formatBaht(c.capSatang)}฿` : null,
    ].filter(Boolean);
    lines.push(`เกมละ ${formatBaht(c.perGameRateSatang)}฿${extras.length ? ` (${extras.join(', ')})` : ''}`);
  } else {
    lines.push(`บุฟเฟ่ต์ ${formatBaht(c.buffetPriceSatang)}฿/คน (${c.buffetShuttlesIncluded ? 'รวมลูก' : 'ลูกแยก'})`);
    if (!c.buffetShuttlesIncluded) shuttleLine();
  }
  if (c.hostFeeSatang > 0) lines.push(`ค่าจัดก๊วน ${formatBaht(c.hostFeeSatang)}฿/คน (รวมในยอดแล้ว)`);
  // Quote the fee actually charged (on a walk-in row), not the configured one:
  // the engine rounds the fee up to a whole rounding step, so a 15฿ fee at 10฿
  // rounding is charged as 20฿.
  const chargedWalkInFee = result.rows.find((r) => r.status === 'billed' && r.walkIn)?.walkInFeeSatang ?? 0;
  if (c.walkInFeeSatang > 0 && chargedWalkInFee > 0 && result.totals.walkInCount > 0) {
    lines.push(`Walk-in +${formatBaht(chargedWalkInFee)}฿/คน × ${result.totals.walkInCount} คน (หารคืนทุกคน)`);
  }
  const byId = new Map(result.rows.filter((r) => r.status === 'billed').map((r) => [r.playerId, r]));
  for (const p of players) {
    const r = byId.get(p.playerId);
    if (!r) continue;
    lines.push(`${p.name}  ${r.games} เกม  ${formatBaht(r.amountSatang)}฿${r.walkIn ? ' (walk-in)' : ''}`);
  }
  lines.push(`รวม ${formatBaht(result.totals.collectedSatang)}฿`);
  return lines.join('\n');
}
