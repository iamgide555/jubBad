import { copyableNumber, parsePayAccount, serializePayAccount, validatePayAccount } from './pay-account';

describe('validatePayAccount', () => {
  it('trims and accepts a full account', () => {
    expect(validatePayAccount({ bank: ' กสิกร ', number: '123-4-56789-0', name: 'สมชาย' })).toEqual({
      ok: true,
      value: { bank: 'กสิกร', number: '123-4-56789-0', name: 'สมชาย' },
    });
  });

  it('treats all-blank input as clearing the account', () => {
    expect(validatePayAccount({})).toEqual({ ok: true, value: null });
    expect(validatePayAccount({ bank: ' ', number: '', name: '  ' })).toEqual({ ok: true, value: null });
  });

  it('rejects a partial account', () => {
    expect(validatePayAccount({ bank: 'x', number: '', name: '' })).toEqual({ ok: false });
    expect(validatePayAccount({ bank: 'กสิกร', number: '12345678', name: '' })).toEqual({ ok: false });
  });

  it('rejects an account number of the wrong length or with bad characters', () => {
    const rest = { bank: 'กสิกร', name: 'สมชาย' };
    expect(validatePayAccount({ ...rest, number: '12' })).toEqual({ ok: false });
    expect(validatePayAccount({ ...rest, number: '1'.repeat(21) })).toEqual({ ok: false });
    expect(validatePayAccount({ ...rest, number: '12ab3456' })).toEqual({ ok: false });
    expect(validatePayAccount({ ...rest, number: '1'.repeat(20) }).ok).toBe(true);
    expect(validatePayAccount({ ...rest, number: '1'.repeat(6) }).ok).toBe(true);
  });

  it('requires at least 6 digits, so a dashes-only or spaces-only number is invalid', () => {
    const rest = { bank: 'กสิกร', name: 'สมชาย' };
    expect(validatePayAccount({ ...rest, number: '------' })).toEqual({ ok: false });
    expect(validatePayAccount({ ...rest, number: '12-34 5' })).toEqual({ ok: false });
    expect(validatePayAccount({ ...rest, number: '12-34 56' }).ok).toBe(true);
  });

  it('reads null like a blank field: all null clears, null beside a filled field is partial', () => {
    const bad = (input: unknown) => validatePayAccount(input as Parameters<typeof validatePayAccount>[0]);
    expect(bad({ bank: null, number: null, name: null })).toEqual({ ok: true, value: null });
    expect(bad({ bank: null })).toEqual({ ok: true, value: null });
    expect(bad({ bank: 'กสิกร', number: null, name: null })).toEqual({ ok: false });
    expect(bad({ bank: 'กสิกร', number: '12345678', name: null })).toEqual({ ok: false });
  });

  it('treats a non-string field as invalid instead of throwing', () => {
    const bad = (input: unknown) => validatePayAccount(input as Parameters<typeof validatePayAccount>[0]);
    expect(bad({ bank: 5 })).toEqual({ ok: false });
    expect(bad({ bank: 'กสิกร', number: 12345678, name: 'สมชาย' })).toEqual({ ok: false });
    expect(bad({ bank: 'กสิกร', number: '12345678', name: { x: 1 } })).toEqual({ ok: false });
  });

  it('rejects a bank over 40 or a name over 80 characters', () => {
    const number = '12345678';
    expect(validatePayAccount({ bank: 'ก'.repeat(41), number, name: 'สมชาย' })).toEqual({ ok: false });
    expect(validatePayAccount({ bank: 'ก'.repeat(40), number, name: 'สมชาย' }).ok).toBe(true);
    expect(validatePayAccount({ bank: 'กสิกร', number, name: 'ส'.repeat(81) })).toEqual({ ok: false });
    expect(validatePayAccount({ bank: 'กสิกร', number, name: 'ส'.repeat(80) }).ok).toBe(true);
  });
});

describe('copyableNumber', () => {
  it('keeps digits only', () => {
    expect(copyableNumber('123-4 5678')).toBe('12345678');
  });
});

describe('parsePayAccount / serializePayAccount', () => {
  it('reads malformed, wrong-typed, partial or over-limit values as null', () => {
    expect(parsePayAccount(null)).toBeNull();
    expect(parsePayAccount('{not json')).toBeNull();
    expect(parsePayAccount('{"bank":1}')).toBeNull();
    expect(parsePayAccount('[]')).toBeNull();
    expect(parsePayAccount('{"bank":"กสิกร","number":"12345678"}')).toBeNull();
    expect(parsePayAccount(JSON.stringify({ bank: 'ก'.repeat(41), number: '12345678', name: 'a' }))).toBeNull();
    expect(parsePayAccount(JSON.stringify({ bank: 'k', number: '12', name: 'a' }))).toBeNull();
    expect(parsePayAccount(JSON.stringify({ bank: 'k', number: '------', name: 'a' }))).toBeNull();
  });

  it('round-trips a valid account and serializes null as null', () => {
    const account = { bank: 'กสิกร', number: '123-4-56789-0', name: 'สมชาย' };
    expect(parsePayAccount(serializePayAccount(account))).toEqual(account);
    expect(serializePayAccount(null)).toBeNull();
  });
});
