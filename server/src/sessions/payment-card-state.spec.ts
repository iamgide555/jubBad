import {
  EMPTY_PAYMENT_STATE,
  newShareToken,
  parsePaymentState,
  serializePaymentState,
  type PaymentCardState,
} from './payment-card-state';

describe('parsePaymentState', () => {
  it('reads null, malformed or wrong-shaped values as the empty state without throwing', () => {
    expect(parsePaymentState(null)).toEqual(EMPTY_PAYMENT_STATE);
    expect(parsePaymentState('garbage')).toEqual(EMPTY_PAYMENT_STATE);
    expect(parsePaymentState('[]')).toEqual(EMPTY_PAYMENT_STATE);
    expect(parsePaymentState('{"token":5}')).toEqual(EMPTY_PAYMENT_STATE);
  });

  it('freezes the empty state so a caller cannot corrupt later empty reads', () => {
    expect(Object.isFrozen(EMPTY_PAYMENT_STATE)).toBe(true);
    expect(parsePaymentState('garbage')).toBe(EMPTY_PAYMENT_STATE);
    expect(() => {
      (EMPTY_PAYMENT_STATE as { token: string | null }).token = 'x';
    }).toThrow(TypeError);
    expect(parsePaymentState(null).token).toBeNull();
  });

  it('drops a bad account but keeps the other fields', () => {
    const raw = JSON.stringify({ account: { bank: 1 }, token: 'abc', confirmedAt: null, confirmedHash: null, lastSentAt: null });
    expect(parsePaymentState(raw)).toEqual({ ...EMPTY_PAYMENT_STATE, token: 'abc' });
  });

  it('round-trips a full state', () => {
    const state: PaymentCardState = {
      account: { bank: 'กสิกร', number: '123-4-56789-0', name: 'สมชาย' },
      token: 'tok_-123',
      confirmedAt: '2026-10-29T10:00:00.000Z',
      confirmedHash: 'deadbeef',
      lastSentAt: '2026-10-29T10:05:00.000Z',
      lastDmAt: '2026-10-29T10:06:00.000Z',
    };
    expect(parsePaymentState(serializePaymentState(state))).toEqual(state);
  });

  it('reads a state stored before lastDmAt existed, and a bad lastDmAt, as null', () => {
    expect(parsePaymentState('{"token":"abc","lastSentAt":"2026-10-29T10:05:00.000Z"}').lastDmAt).toBeNull();
    expect(parsePaymentState('{"token":"abc","lastDmAt":7}').lastDmAt).toBeNull();
    expect(parsePaymentState('{"lastDmAt":"2026-10-29T10:06:00.000Z"}').lastDmAt).toBe('2026-10-29T10:06:00.000Z');
  });

  it('round-trips the empty state', () => {
    expect(parsePaymentState(serializePaymentState(EMPTY_PAYMENT_STATE))).toEqual(EMPTY_PAYMENT_STATE);
  });
});

describe('newShareToken', () => {
  it('is url-safe, long enough and unique per call', () => {
    const a = newShareToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(newShareToken()).not.toBe(a);
  });
});
