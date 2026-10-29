/**
 * The only place Group.payAccount is parsed or written. Tolerant on read: a
 * malformed, wrong-typed, partial or over-limit column reads as null (no
 * account), so a stored value can never break the payment card (same stance
 * as bill-config.ts). Strict validation of new input is validatePayAccount.
 */
export interface PayAccount {
  bank: string;
  number: string;
  name: string;
}

const MAX_BANK = 40;
const MAX_NAME = 80;
/** Digits, spaces and dashes, 6-20 characters: how people actually type an account number. */
const NUMBER_PATTERN = /^[0-9 -]{6,20}$/;
const MIN_DIGITS = 6;

/** Either all three fields are present or none: a partial account is invalid. */
export function validatePayAccount(input: {
  bank?: string;
  number?: string;
  name?: string;
}): { ok: true; value: PayAccount | null } | { ok: false } {
  // Callers can hand over unvalidated JSON: a non-string field is invalid, never a throw.
  if ([input.bank, input.number, input.name].some((v) => v !== undefined && typeof v !== 'string')) {
    return { ok: false };
  }
  const bank = (input.bank ?? '').trim();
  const number = (input.number ?? '').trim();
  const name = (input.name ?? '').trim();
  if (bank === '' && number === '' && name === '') return { ok: true, value: null };
  if (bank === '' || number === '' || name === '') return { ok: false };
  if (bank.length > MAX_BANK || name.length > MAX_NAME || !NUMBER_PATTERN.test(number)) return { ok: false };
  // Spaces and dashes alone can satisfy the pattern; the copyable number must still be a real one.
  if (copyableNumber(number).length < MIN_DIGITS) return { ok: false };
  return { ok: true, value: { bank, number, name } };
}

export function parsePayAccount(raw: string | null): PayAccount | null {
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  return payAccountFromUnknown(v);
}

/** Shared with payment-card-state.ts, which embeds an account snapshot. */
export function payAccountFromUnknown(v: unknown): PayAccount | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o['bank'] !== 'string' || typeof o['number'] !== 'string' || typeof o['name'] !== 'string') return null;
  const result = validatePayAccount({ bank: o['bank'], number: o['number'], name: o['name'] });
  return result.ok ? result.value : null;
}

export function serializePayAccount(account: PayAccount | null): string | null {
  return account === null ? null : JSON.stringify(account);
}

/** What a payer pastes into their banking app: the number with every space and dash removed. */
export function copyableNumber(number: string): string {
  return number.replace(/[^0-9]/g, '');
}
