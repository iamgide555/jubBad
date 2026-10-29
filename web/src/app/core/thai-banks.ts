export interface ThaiBank {
  /** The display name: what is stored, and what the payment card shows. Never a code. */
  name: string;
  /** Only for search ("kbank" finds กสิกร); never stored or shown on a card. */
  alias: string;
}

/**
 * The banks offered in the account field, in the owner's order. It only fills a text field: a
 * saved account holds the Thai name as plain text, so editing this list cannot change one.
 * A bank that is not here is typed as free text.
 */
export const THAI_BANKS: readonly ThaiBank[] = [
  { name: 'กรุงไทย', alias: 'KTB' },
  { name: 'กรุงเทพ', alias: 'BBL' },
  { name: 'กสิกร', alias: 'KBANK' },
  { name: 'ธนชาต', alias: 'TTB' },
  { name: 'ไทยพาณิชย์', alias: 'SCB' },
  { name: 'ซีไอเอ็มบี', alias: 'CIMBT' },
  { name: 'ยูโอบี', alias: 'UOB' },
  { name: 'กรุงศรี', alias: 'BAY' },
  { name: 'ออมสิน', alias: 'GSB' },
  { name: 'แลนด์แอนด์เฮ้าส์', alias: 'LHBANK' },
  { name: 'ทิสโก้', alias: 'TISCO' },
  { name: 'PromptPay', alias: 'PromptPay' },
];

/** Banks whose Thai name or alias contains the query (trimmed, case-insensitive). Blank returns all. */
export function searchBanks(query: string): ThaiBank[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...THAI_BANKS];
  return THAI_BANKS.filter((b) => b.name.toLowerCase().includes(q) || b.alias.toLowerCase().includes(q));
}
