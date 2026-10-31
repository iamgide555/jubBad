import request from 'supertest';
import { bootSlipApp, lineUser } from '../../../test/slip-http.fixture.js';

type Kit = Awaited<ReturnType<typeof bootSlipApp>>;
describe('LINE payment share success acknowledgement', () => {
  let kit: Kit;
  let hostId: string;
  beforeAll(async () => {
    kit = await bootSlipApp(); hostId = (await kit.owner()).id;
    await kit.prisma.user.update({where:{id:hostId},data:{lineUserId:'USHAREHOST'}});
  });
  afterAll(() => kit.cleanup());
  beforeEach(() => {
    for (const [key,value] of Object.entries({LINE_CHANNEL_ACCESS_TOKEN:'test-token',LINE_CHANNEL_SECRET:'test-secret',PUBLIC_APP_URL:'https://example.test',LINE_LIFF_ID:'123-a',LINE_LOGIN_CHANNEL_ID:'123'})) vi.stubEnv(key,value);
    kit.resetThrottles(); kit.liff.verify.mockResolvedValue(lineUser());
  });
  afterEach(() => vi.unstubAllEnvs());
  async function setup() {
    const s = await kit.setup(hostId);
    await kit.prisma.group.update({where:{code:s.groupCode},data:{lineDmEnabled:true}});
    return s;
  }
  const ack = (code: string, token: string, access?: string) => {
    const r = request(kit.server).post(`/sessions/${code}/payment-share-card/sent?token=${encodeURIComponent(token)}`);
    return (access ? r.set('X-Line-Access-Token',access) : r).send({});
  };

  it('records actual picker success separately from opening the card and keeps payment records untouched', async () => {
    const s = await setup();
    expect((await kit.cards.panel(s.code)).lastSentAt).toBeNull();
    await kit.cards.shareCard(s.code,s.token);
    expect((await kit.cards.panel(s.code)).lastSentAt).toBeNull();
    await ack(s.code,s.token,'ACCESS').expect(200,{ok:true});
    const sent = (await kit.cards.panel(s.code)).lastSentAt;
    expect(sent).toEqual(expect.any(String));
    await ack(s.code,s.token,'ACCESS').expect(200);
    expect((await kit.cards.panel(s.code)).lastSentAt).toBe(sent);
    expect(await kit.prisma.sessionPayment.count({where:{sessionId:s.code}})).toBe(0);
    expect((await kit.prisma.session.findUniqueOrThrow({where:{code:s.code}})).paymentCard).toContain(s.token);
  });

  it('preserves session collection access after reconfirmation but still revokes the old share token', async () => {
    const s = await setup();
    await ack(s.code,s.token,'ACCESS').expect(200);
    const sent = (await kit.cards.panel(s.code)).lastSentAt;
    const card = await kit.cards.panel(s.code);
    await kit.cards.confirm(s.code,{expectedHash:card.contentHash,bank:'กสิกร',number:'1234567890',name:'สมหญิง'});
    expect((await kit.cards.panel(s.code)).lastSentAt).toBe(sent);
    await ack(s.code,s.token,'ACCESS').expect(404);
  });

  it('refuses missing identity, invalid identity, wrong token and revoked token without recording a send', async () => {
    const s = await setup();
    await ack(s.code,s.token).expect(404);
    kit.liff.verify.mockResolvedValueOnce(null);
    await ack(s.code,s.token,'INVALID').expect(404);
    await ack(s.code,'wrong','ACCESS').expect(404);
    await kit.confirm(s.code,'fresh-token');
    await ack(s.code,s.token,'ACCESS').expect(404);
    expect((await kit.cards.panel(s.code)).lastSentAt).toBeNull();
  });
});
