import { vi } from 'vitest';
import { GuestMenuService } from './guest-menu.service.js';
import type { LineClient } from './line-client.js';

describe('GuestMenuService', () => {
  const saved = { ...process.env };
  const client = { linkRichMenu: vi.fn(), unlinkRichMenu: vi.fn() };
  let menu: GuestMenuService;

  beforeEach(() => {
    process.env.LINE_GUEST_RICHMENU_ID = 'RM1';
    client.linkRichMenu.mockReset().mockResolvedValue(true);
    client.unlinkRichMenu.mockReset().mockResolvedValue(true);
    menu = new GuestMenuService(client as unknown as LineClient);
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('links the menu once per LINE user per process', async () => {
    await menu.show('U1');
    await menu.show('U1');
    expect(client.linkRichMenu).toHaveBeenCalledTimes(1);
    expect(client.linkRichMenu).toHaveBeenCalledWith('U1', 'RM1');
  });

  it('tries again after a failed link', async () => {
    client.linkRichMenu.mockResolvedValueOnce(false);
    await menu.show('U1');
    await menu.show('U1');
    expect(client.linkRichMenu).toHaveBeenCalledTimes(2);
  });

  it('force links again even when this process already did (a follow means LINE has no menu for them now)', async () => {
    await menu.show('U1');
    await menu.show('U1', true);
    expect(client.linkRichMenu).toHaveBeenCalledTimes(2);
  });

  it('hide unlinks and lets a later show link again', async () => {
    await menu.show('U1');
    await menu.hide('U1');
    expect(client.unlinkRichMenu).toHaveBeenCalledWith('U1');
    await menu.show('U1');
    expect(client.linkRichMenu).toHaveBeenCalledTimes(2);
  });

  it('forget lets a later show link again without calling LINE', async () => {
    await menu.show('U1');
    menu.forget('U1');
    expect(client.unlinkRichMenu).not.toHaveBeenCalled();
    await menu.show('U1');
    expect(client.linkRichMenu).toHaveBeenCalledTimes(2);
  });

  it('never throws when LINE does', async () => {
    client.linkRichMenu.mockRejectedValue(new Error('boom'));
    client.unlinkRichMenu.mockRejectedValue(new Error('boom'));
    await expect(menu.show('U1')).resolves.toBeUndefined();
    await expect(menu.hide('U1')).resolves.toBeUndefined();
  });

  it('does nothing at all when LINE_GUEST_RICHMENU_ID is unset', async () => {
    delete process.env.LINE_GUEST_RICHMENU_ID;
    await menu.show('U1');
    await menu.hide('U1');
    menu.forget('U1');
    expect(client.linkRichMenu).not.toHaveBeenCalled();
    expect(client.unlinkRichMenu).not.toHaveBeenCalled();
  });
});
