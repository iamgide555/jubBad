import { bootSlipApp, lineUser } from '../../../test/slip-http.fixture.js';
import { SlipPaymentsService } from './slip-payments.service.js';

type Kit = Awaited<ReturnType<typeof bootSlipApp>>;

describe('SlipPaymentsService.payPageView and claimForPayPage', () => {
  let kit: Kit;
  let slips: SlipPaymentsService;
  let hostId: string;

  beforeAll(async () => {
    kit = await bootSlipApp();
    slips = kit.app.get(SlipPaymentsService);
    hostId = (await kit.owner()).id;
  });
  afterAll(() => kit.cleanup());

  it('is null for a missing, wrong or unknown token, and for an unknown session', async () => {
    const { code, token } = await kit.setup(hostId);
    const user = lineUser();
    expect(await slips.payPageView(code, undefined, user)).toBeNull();
    expect(await slips.payPageView(code, `${token}x`, user)).toBeNull();
    expect(await slips.payPageView('no-such-session', token, user)).toBeNull();
    expect(await slips.payPageView(code, token, user)).not.toBeNull();
  });

  it('is null (and claims nothing) below the host plan, with no confirmed card, and after a reconfirm', async () => {
    const lapsed = await kit.owner('host', new Date(Date.now() - 86_400_000));
    const a = await kit.setup(lapsed.id);
    const user = lineUser();
    expect(await slips.payPageView(a.code, a.token, user)).toBeNull();
    expect(await slips.claimForPayPage(a.code, a.token, user, a.ids[0])).toBeNull();

    const b = await kit.setup(hostId);
    await kit.prisma.session.update({ where: { code: b.code }, data: { paymentCard: null } });
    expect(await slips.payPageView(b.code, b.token, user)).toBeNull();
    expect(await slips.claimForPayPage(b.code, b.token, user, b.ids[0])).toBeNull();

    const c = await kit.setup(hostId);
    await kit.confirm(c.code, 'a-brand-new-token-0123456');
    expect(await slips.claimForPayPage(c.code, c.token, user, c.ids[0])).toBeNull();
    // No link was written by any refused claim.
    expect(await kit.prisma.playerLineAccount.count({ where: { lineUserId: user.userId } })).toBe(0);
    expect(await slips.claimForPayPage(c.code, 'a-brand-new-token-0123456', user, c.ids[0])).toBe('linked');
  });

  it('gives the card account name, the linked row, and only unpaid unlinked players as claimable', async () => {
    const { code, token, ids } = await kit.setup(hostId);
    const me = lineUser();
    const before = await slips.payPageView(code, token, me);
    expect(before).toMatchObject({ amountSatang: null, playerName: null, alreadyPaid: false, accountName: 'สมหญิง ใจดี' });
    expect(before!.claimable).toHaveLength(4);

    expect(await slips.claimForPayPage(code, token, me, ids[0])).toBe('linked');
    await slips.tick(code, ids[1]);
    const after = await slips.payPageView(code, token, me);
    expect(after).toMatchObject({ amountSatang: await kit.owed(code, ids[0]), alreadyPaid: false });
    expect(after!.claimable.map((c) => c.playerId).sort()).toEqual([ids[2], ids[3]].sort());
  });

  it('names the night the bill is for, as the card writes it, or null without a session date', async () => {
    const { code, token } = await kit.setup(hostId);
    // The fixture's session date is 2026-10-30, stored as yyyy-mm-dd: written as a Thai date like the card's.
    expect(await slips.payPageView(code, token, lineUser())).toMatchObject({ sessionDate: '30 ต.ค. 2569' });
    await kit.prisma.session.update({ where: { code }, data: { date: 'พฤหัส 30 ต.ค.' } });
    expect(await slips.payPageView(code, token, lineUser())).toMatchObject({ sessionDate: 'พฤหัส 30 ต.ค.' });
    await kit.prisma.session.update({ where: { code }, data: { date: null } });
    expect(await slips.payPageView(code, token, lineUser())).toMatchObject({ sessionDate: null });
  });

  it('shows no amount for a viewer linked to a player who is not on tonight\'s bill', async () => {
    const { code, token, groupCode } = await kit.setup(hostId);
    const stray = await kit.prisma.player.create({ data: { groupId: groupCode, name: 'ไม่มา', aliases: '[]' } });
    const me = lineUser();
    await slips.setLink(code, stray.id, me.userId);
    expect(await slips.payPageView(code, token, me)).toMatchObject({ amountSatang: null, playerName: null, alreadyPaid: false });
  });
});
