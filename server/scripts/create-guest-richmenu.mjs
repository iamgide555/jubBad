#!/usr/bin/env node
/**
 * Creates the rich menu shown to a LINE user who has no JubBad account (sign up / link an account) and
 * prints the line to put in the server's environment. Run once per LINE channel; the bot links the menu to
 * each guest itself (see GuestMenuService) and never sets it as the default.
 *
 * Needs LINE_CHANNEL_ACCESS_TOKEN and LINE_LIFF_ID in the environment, for example:
 *   node --env-file-if-exists=.env scripts/create-guest-richmenu.mjs   (on a laptop)
 *   docker compose exec -T api node scripts/create-guest-richmenu.mjs  (on the server: the variables are already there)
 *
 * The image is assets/line/guest-menu.png (2500x843, under LINE's 1 MB limit).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API = 'https://api.line.me/v2/bot';
const DATA_API = 'https://api-data.line.me/v2/bot';
const IMAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'line', 'guest-menu.png');
const MAX_IMAGE_BYTES = 1024 * 1024;

/** Two halves of one 2500x843 image: sign up on the left, link an account you already have on the right. */
export function guestMenuDefinition(liffId) {
  return {
    size: { width: 2500, height: 843 },
    selected: true,
    name: 'jubbad-guest',
    chatBarText: 'เมนู',
    areas: [
      {
        bounds: { x: 0, y: 0, width: 1250, height: 843 },
        action: { type: 'uri', uri: `https://liff.line.me/${liffId}/signup` },
      },
      {
        bounds: { x: 1250, y: 0, width: 1250, height: 843 },
        action: { type: 'uri', uri: `https://liff.line.me/${liffId}/link` },
      },
    ],
  };
}

async function call(url, token, init) {
  const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`LINE answered ${response.status}: ${body.message ?? 'no message'}`);
  return body;
}

async function main() {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  const liffId = process.env.LINE_LIFF_ID?.trim();
  if (!token || !liffId) throw new Error('LINE_CHANNEL_ACCESS_TOKEN and LINE_LIFF_ID must both be set.');

  const image = await readFile(IMAGE);
  if (image.length > MAX_IMAGE_BYTES) throw new Error(`The menu image is ${image.length} bytes; LINE allows 1 MB.`);

  const { richMenuId } = await call(`${API}/richmenu`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(guestMenuDefinition(liffId)),
  });
  try {
    await call(`${DATA_API}/richmenu/${richMenuId}/content`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: image,
    });
  } catch (error) {
    // A menu with no image is useless and would sit in the channel: take it away again.
    await call(`${API}/richmenu/${richMenuId}`, token, { method: 'DELETE', headers: {} }).catch(() => {});
    throw error;
  }
  console.log(`LINE_GUEST_RICHMENU_ID=${richMenuId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
