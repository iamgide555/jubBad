import { THAI_BANKS, searchBanks } from './thai-banks';

describe('thai banks', () => {
  it('lists the twelve banks in the owner order', () => {
    expect(THAI_BANKS.map((b) => b.name)).toEqual([
      'กรุงไทย',
      'กรุงเทพ',
      'กสิกร',
      'ธนชาต',
      'ไทยพาณิชย์',
      'ซีไอเอ็มบี',
      'ยูโอบี',
      'กรุงศรี',
      'ออมสิน',
      'แลนด์แอนด์เฮ้าส์',
      'ทิสโก้',
      'PromptPay',
    ]);
  });

  it('an empty or blank query returns every bank', () => {
    expect(searchBanks('')).toHaveLength(12);
    expect(searchBanks('   ')).toHaveLength(12);
  });

  it('finds กสิกร by a Thai prefix and by its English alias', () => {
    expect(searchBanks('กส').map((b) => b.name)).toEqual(['กสิกร']);
    expect(searchBanks('kbank').map((b) => b.name)).toEqual(['กสิกร']);
  });

  it('trims and ignores case', () => {
    expect(searchBanks('  scb ').map((b) => b.name)).toEqual(['ไทยพาณิชย์']);
    expect(searchBanks('promptpay').map((b) => b.name)).toEqual(['PromptPay']);
  });

  it('an unknown query returns nothing', () => {
    expect(searchBanks('Dime')).toEqual([]);
  });
});
