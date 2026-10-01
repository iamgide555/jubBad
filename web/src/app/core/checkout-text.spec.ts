import { buildCheckoutText } from './checkout-text';
import type { CheckoutPreview, CheckoutReceipt } from './checkout.model';

const breakdown = { baseSatang: 3000, shuttleSatang: 1550, hostFeeSatang: 500, walkInFeeSatang: 0, discountSatang: 0 };
const preview: CheckoutPreview = { playerId: 'p', model: 'perShuttle', amountSatang: 5100, games: 2, breakdown, snapshotHash: 'h' };
const receipt: CheckoutReceipt = { id: 'r', playerId: 'p', model: 'perShuttle', amountSatang: 5100, breakdown, settledAt: '2026-10-01T10:00:00Z' };

describe('buildCheckoutText', () => {
  it('labels a preview as an estimate, not as paid', () => {
    const text = buildCheckoutText(preview, 'นุ่น');
    expect(text).toContain('ยอดโดยประมาณ นุ่น');
    expect(text).toContain('ยังไม่ได้ชำระ');
    expect(text).toContain('เล่น 2 เกม');
    expect(text).toContain('รวม 51 บาท');
  });

  it('says a saved receipt is settled and shows satang exactly', () => {
    const text = buildCheckoutText(receipt, 'นุ่น');
    expect(text).toContain('เช็คเอาต์แล้ว');
    expect(text).not.toContain('ยังไม่ได้ชำระ');
    expect(text).toContain('ค่าลูกแบด 15.50 บาท');
    expect(text).toContain('ค่าดูแล 5 บาท');
  });

  it('omits zero lines and names the walk-in fee when present', () => {
    const text = buildCheckoutText({ ...preview, model: 'perGame', breakdown: { ...breakdown, shuttleSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 2000 } }, 'A');
    expect(text).not.toContain('ค่าลูกแบด');
    expect(text).not.toContain('ค่าดูแล');
    expect(text).toContain('ค่าคนนอกรายชื่อ 20 บาท');
    expect(text).toContain('คิดต่อเกม');
  });
});
