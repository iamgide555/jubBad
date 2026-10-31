import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SlipOcr } from './slip-ocr.js';
import { SlipReader } from './slip-reader.js';

// Runs only against a local folder of real slip images (never committed):
//   SLIP_FIXTURE_DIR=/path/to/slips npx vitest run src/sessions/slips/slip-ocr.fixtures.spec.ts
const dir = process.env.SLIP_FIXTURE_DIR;

describe.skipIf(!dir)('real slips (SLIP_FIXTURE_DIR)', () => {
  const ocr = new SlipOcr();
  const reader = new SlipReader(ocr);
  const files = dir
    ? readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f))
    : [];

  afterAll(() => ocr.onModuleDestroy());

  it('finds slip images in the folder', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`reads ${file}`, async () => {
      const result = await reader.read(readFileSync(path.join(dir!, file)));
      expect(result.kind).toBe('slip');
      if (result.kind === 'slip') {
        expect(result.ocr.text).toMatch(/\d+\.\d{2}/);
      }
    }, 30_000);
  }
});
