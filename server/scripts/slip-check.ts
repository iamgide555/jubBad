/**
 * Reads every slip image in a folder and prints what the slip pipeline sees,
 * so OCR changes can be checked against real slips locally.
 *
 * Prints structure only (bank code, reference, amount-like tokens, receiver
 * name and tail, milliseconds); nothing is written to disk.
 *
 * Usage (from server/, after `npm run build`):
 *   npm run slip:check -- <folder>
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { SlipOcr } from '../dist/server/src/sessions/slips/slip-ocr.js';
import { receiverName, receiverTail } from '../dist/server/src/sessions/slips/slip-match.js';
import { SlipReader } from '../dist/server/src/sessions/slips/slip-reader.js';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: npm run slip:check -- <folder>');
  process.exit(2);
}

const files = readdirSync(dir)
  .filter((f) => /\.(jpe?g|png)$/i.test(f))
  .sort();
const ocr = new SlipOcr();
const reader = new SlipReader(ocr);

try {
  for (const file of files) {
    const image = readFileSync(path.join(dir, file));
    const started = performance.now();
    const result = await reader.read(image);
    const ms = Math.round(performance.now() - started);
    if (result.kind === 'not-slip') {
      console.log(`${file}: not a slip (${ms} ms)`);
      continue;
    }
    const amounts = result.ocr.text.match(/\d[\d,]*\.\d{2}/g) ?? [];
    console.log(
      `${file}: bank=${result.qr.bankCode} ref=${result.qr.reference} ` +
        `amounts=[${amounts.join(', ')}] ` +
        `receiverName=${JSON.stringify(receiverName(result.ocr.lines))} ` +
        `receiverTail=${JSON.stringify(receiverTail(result.ocr.text))} ` +
        `(${ms} ms)`,
    );
  }
} finally {
  await ocr.onModuleDestroy();
}
