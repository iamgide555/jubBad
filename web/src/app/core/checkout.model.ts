/** Early checkout (host feedback E): host-only transport types. Never part of the public session feed. */
export type CheckoutModel = 'perGame' | 'perShuttle' | 'buffet';
export const CHECKOUT_MODELS: readonly CheckoutModel[] = ['perGame', 'perShuttle', 'buffet'];

export interface CheckoutBreakdown {
  baseSatang: number;
  shuttleSatang: number;
  hostFeeSatang: number;
  walkInFeeSatang: number;
  discountSatang: number;
}

/** A quote: changes nothing and reserves nothing. `snapshotHash` ties a confirmation to what was priced. */
export interface CheckoutPreview {
  playerId: string;
  model: CheckoutModel;
  amountSatang: number;
  games: number;
  breakdown: CheckoutBreakdown;
  snapshotHash: string;
  /** Which basis priced a perShuttle quote (absent on older servers). */
  shuttleCharge?: 'shared' | 'full';
  /** The resolved charge per player per shuttle under 'full', else null. */
  chargeSatang?: number | null;
  /** The session's shuttle price, so the rates form can show what the quote used. */
  shuttlePriceSatang?: number | null;
}

/** A settled checkout, frozen. */
export interface CheckoutReceipt {
  id: string;
  playerId: string;
  model: CheckoutModel;
  amountSatang: number;
  breakdown: CheckoutBreakdown;
  settledAt: string;
}

export function modelLabel(model: CheckoutModel): string {
  switch (model) {
    case 'perGame':
      return $localize`:@@checkout.model.perGame:คิดต่อเกม`;
    case 'perShuttle':
      return $localize`:@@checkout.model.perShuttle:ตามลูกแบด`;
    case 'buffet':
      return $localize`:@@checkout.model.buffet:บุฟเฟ่ต์`;
  }
}

/** "คอร์ท 3": the dashboard's court label is often just the number, so the message names it as a court. */
export function courtName(label: string): string {
  return $localize`:@@checkout.courtName:คอร์ท ${label}:label:`;
}

/** Host-facing message for a stable server code; null for one the dialog does not special-case. */
export function checkoutErrorMessage(code: string | null, courtLabel?: string): string | null {
  switch (code) {
    case 'CHECKOUT_STALE':
      return $localize`:@@checkout.err.stale:ข้อมูลเปลี่ยนไปตั้งแต่คำนวณ ยอดถูกคำนวณใหม่ กรุณาตรวจก่อนยืนยัน`;
    case 'PLAYER_CHECKED_OUT':
      return $localize`:@@checkout.err.checkedOut:คนนี้เช็คเอาต์ไปแล้ว`;
    case 'PLAYER_ON_COURT':
      return courtLabel
        ? $localize`:@@checkout.err.onCourtNamed:คนนี้อยู่ที่ ${courtLabel}:court: — เอาออกจากคู่ หรือจบแมตช์ก่อน`
        : $localize`:@@checkout.err.onCourt:คนนี้อยู่บนคอร์ท — เอาออกจากคู่ หรือจบแมตช์ก่อน`;
    case 'UNKNOWN_SHUTTLE_USE':
      return $localize`:@@checkout.err.unknownUse:เกมของคนนี้ยังไม่ได้บันทึกลูกแบด แก้ในหน้าสรุปก๊วนก่อน`;
    case 'MISSING_SHUTTLE_PRICE':
      return $localize`:@@checkout.err.noPrice:ยังไม่ได้ใส่ราคาลูกแบด`;
    case 'PLAYER_REMOVED_FROM_BILL':
      return $localize`:@@checkout.err.removed:คนนี้ถูกตัดออกจากบิล คืนค่าในหน้าบิลก่อน`;
    case 'CHECKOUT_DISABLED':
      return $localize`:@@checkout.err.disabled:ก๊วนนี้ไม่ได้เปิดเครื่องมือลูกแบด`;
    case 'CHECKOUT_UNDONE':
      return $localize`:@@checkout.err.undone:การเช็คเอาต์นี้ถูกยกเลิกไปแล้ว`;
    case 'CHECKOUT_NOT_FOUND':
      return $localize`:@@checkout.err.notFound:ไม่พบรายการเช็คเอาต์นี้`;
    case 'SESSION_ENDED':
      return $localize`:@@checkout.err.ended:ก๊วนนี้จบไปแล้ว`;
    default:
      return null;
  }
}
