import {
  formatShuttleCountInput,
  formatShuttlePriceInput,
  parseShuttleCountInput,
  parseShuttlePriceInput,
} from './shuttle-money';

describe('shuttle-money', () => {
  describe('parseShuttlePriceInput', () => {
    it('converts 80.50 baht to exactly 8050 satang', () => {
      expect(parseShuttlePriceInput('80.50')).toEqual({ ok: true, value: 8050 });
    });

    it('converts a value naive float multiplication gets wrong (19.99 -> 1998.9999999999998)', () => {
      // Sanity-check the premise: plain float multiplication really is broken here.
      expect(19.99 * 100).not.toBe(1999);
      expect(parseShuttlePriceInput('19.99')).toEqual({ ok: true, value: 1999 });
    });

    it('converts another value that trips naive float multiplication (4.35 -> 434.99999999999994)', () => {
      expect(4.35 * 100).not.toBe(435);
      expect(parseShuttlePriceInput('4.35')).toEqual({ ok: true, value: 435 });
    });

    it('converts a value that trips the classic 0.1 + 0.2 style artifact (0.29 baht)', () => {
      expect(0.29 * 100).not.toBe(29);
      expect(parseShuttlePriceInput('0.29')).toEqual({ ok: true, value: 29 });
    });

    it('pads a single decimal digit to full cents', () => {
      expect(parseShuttlePriceInput('0.1')).toEqual({ ok: true, value: 10 });
      expect(parseShuttlePriceInput('7.5')).toEqual({ ok: true, value: 750 });
    });

    it('accepts a whole-baht amount with no decimal point', () => {
      expect(parseShuttlePriceInput('12')).toEqual({ ok: true, value: 1200 });
    });

    it('accepts zero as a valid, explicit value', () => {
      expect(parseShuttlePriceInput('0')).toEqual({ ok: true, value: 0 });
    });

    it('treats blank (or whitespace-only) input as "clear to null"', () => {
      expect(parseShuttlePriceInput('')).toEqual({ ok: true, value: null });
      expect(parseShuttlePriceInput('   ')).toEqual({ ok: true, value: null });
    });

    it('rejects more than 2 decimal places rather than rounding', () => {
      expect(parseShuttlePriceInput('80.505')).toEqual({ ok: false });
      expect(parseShuttlePriceInput('80.999')).toEqual({ ok: false });
    });

    it('rejects negative amounts', () => {
      expect(parseShuttlePriceInput('-1')).toEqual({ ok: false });
      expect(parseShuttlePriceInput('-1.50')).toEqual({ ok: false });
    });

    it('rejects non-numeric input', () => {
      expect(parseShuttlePriceInput('abc')).toEqual({ ok: false });
      expect(parseShuttlePriceInput('1,50')).toEqual({ ok: false });
    });

    it('rejects an amount above the server-side int32 ceiling', () => {
      expect(parseShuttlePriceInput('21474836.48')).toEqual({ ok: false });
    });

    it('accepts an amount right at the server-side int32 ceiling', () => {
      expect(parseShuttlePriceInput('21474836.47')).toEqual({ ok: true, value: 2147483647 });
    });

    it('rejects a trailing decimal point with no digits after it', () => {
      expect(parseShuttlePriceInput('80.')).toEqual({ ok: false });
    });

    it('trims leading/trailing whitespace around an otherwise valid amount', () => {
      expect(parseShuttlePriceInput('  80.50  ')).toEqual({ ok: true, value: 8050 });
      expect(parseShuttlePriceInput('\t12\n')).toEqual({ ok: true, value: 1200 });
    });
  });

  describe('parseShuttleCountInput', () => {
    it('accepts a nonnegative whole number', () => {
      expect(parseShuttleCountInput('12')).toEqual({ ok: true, value: 12 });
    });

    it('accepts zero as a valid, explicit value', () => {
      expect(parseShuttleCountInput('0')).toEqual({ ok: true, value: 0 });
    });

    it('treats blank input as "clear to null"', () => {
      expect(parseShuttleCountInput('')).toEqual({ ok: true, value: null });
      expect(parseShuttleCountInput('  ')).toEqual({ ok: true, value: null });
    });

    it('rejects a decimal count', () => {
      expect(parseShuttleCountInput('12.5')).toEqual({ ok: false });
    });

    it('rejects a negative count', () => {
      expect(parseShuttleCountInput('-1')).toEqual({ ok: false });
    });

    it('rejects non-numeric input', () => {
      expect(parseShuttleCountInput('abc')).toEqual({ ok: false });
    });

    it('rejects a count above the server-side int32 ceiling', () => {
      expect(parseShuttleCountInput('2147483648')).toEqual({ ok: false });
    });

    it('accepts a count right at the server-side int32 ceiling', () => {
      expect(parseShuttleCountInput('2147483647')).toEqual({ ok: true, value: 2147483647 });
    });
  });

  describe('formatShuttleCountInput', () => {
    it('renders null as blank', () => {
      expect(formatShuttleCountInput(null)).toBe('');
    });

    it('renders 0 as "0", distinguishable from blank', () => {
      expect(formatShuttleCountInput(0)).toBe('0');
    });

    it('renders a positive count as plain digits', () => {
      expect(formatShuttleCountInput(12)).toBe('12');
    });
  });

  describe('formatShuttlePriceInput', () => {
    it('renders null as blank', () => {
      expect(formatShuttlePriceInput(null)).toBe('');
    });

    it('renders 0 satang as "0", distinguishable from blank', () => {
      expect(formatShuttlePriceInput(0)).toBe('0');
    });

    it('renders 8050 satang as 80.50 (two decimal places, never truncated)', () => {
      expect(formatShuttlePriceInput(8050)).toBe('80.50');
    });

    it('renders a whole-baht amount with no trailing decimal', () => {
      expect(formatShuttlePriceInput(1200)).toBe('12');
    });

    it('renders single-digit cents with a leading zero', () => {
      expect(formatShuttlePriceInput(1205)).toBe('12.05');
    });

    it('round-trips 80.50 baht through parse then format', () => {
      const parsed = parseShuttlePriceInput('80.50');
      expect(parsed.ok).toBe(true);
      expect(formatShuttlePriceInput(parsed.ok ? parsed.value : null)).toBe('80.50');
    });
  });
});
