import { lineConfig } from '../line/line-config.js';
import { upgradeContactUrl } from '../plans/plan.js';

export interface MissingSetting {
  name: string;
  /** What stops working, in a sentence an operator can act on. */
  effect: string;
}

/**
 * Which sign-up settings are not in place, with what each one costs. The app boots either way (each part degrades on
 * its own), so without this a half-configured deploy looks fine and just quietly offers less.
 */
export function signupReadiness(): { missing: MissingSetting[] } {
  const config = lineConfig();
  const missing: MissingSetting[] = [];
  if (config.liffId === null)
    missing.push({ name: 'LINE_LIFF_ID', effect: 'sign-up and link pages in LINE are unavailable and no trial is offered' });
  if (config.loginChannelId === null)
    missing.push({ name: 'LINE_LOGIN_CHANNEL_ID', effect: 'LINE cannot verify who is signing up, so the LINE pages and the trial offer are off' });
  if (config.botAddUrl === null)
    missing.push({ name: 'LINE_BOT_ADD_URL', effect: 'no "add the bot" button after signing up through LINE (must be an https link)' });
  if (config.publicAppUrl === null)
    missing.push({ name: 'PUBLIC_APP_URL', effect: 'the bot cannot send password-reset or login links' });
  if (config.guestRichMenuId === null)
    missing.push({ name: 'LINE_GUEST_RICHMENU_ID', effect: 'no guest menu in the bot chat (run scripts/create-guest-richmenu.mjs)' });
  if (upgradeContactUrl(process.env.UPGRADE_CONTACT_URL) === null)
    missing.push({ name: 'UPGRADE_CONTACT_URL', effect: 'the upgrade sheet shows text only, with no way for a host to reach you (must be an https link)' });
  return { missing };
}
