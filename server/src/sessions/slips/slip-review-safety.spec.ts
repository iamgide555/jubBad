import request from 'supertest';
import { bootSlipApp, lineUser, newRef, slipRead } from '../../../test/slip-http.fixture.js';
import { BillService } from '../bill.service.js';
import { SlipImagesService } from './slip-images.service.js';
import { SessionsService } from '../sessions.service.js';
import { SlipPaymentsService } from './slip-payments.service.js';

type Kit = Awaited<ReturnType<typeof bootSlipApp>>;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

describe('slip review amounts and collection lifecycle', () => {
  let kit: Kit;
  let owner: Awaited<ReturnType<Kit['owner']>>;
  let slips: SlipPaymentsService;
  beforeAll(async () => { kit = await bootSlipApp(); owner = await kit.owner(); slips = kit.app.get(SlipPaymentsService); });
  afterAll(() => kit.cleanup());
  beforeEach(() => { kit.resetThrottles(); kit.reader.read.mockReset(); kit.liff.verify.mockResolvedValue(lineUser()); });
  async function waiting(amount: number | null = 28400) {
    const session = await kit.setup(owner.id);
    const slip = await kit.prisma.pendingSlip.create({ data: {
      sessionId: session.code, groupId: session.groupCode, reference: newRef(), lineUserId: lineUser().userId,
      reason: 'unmapped', amountSatang: amount,
    } });
    return { ...session, slip };
  }
  const conflict = async (call: Promise<unknown>, code: string) => {
    await expect(call).rejects.toMatchObject({ response: { code } });
  };

  it('refuses combined total above slip amount without any writes', async () => {
    const s = await waiting();
    await conflict(slips.resolveWaiting(s.code, s.slip.id, { coversPlayerIds: s.ids.slice(0, 2), senderPlayerId: null }), 'SLIP_AMOUNT_MISMATCH');
    expect(await kit.prisma.sessionPayment.count({ where: { sessionId: s.code } })).toBe(0);
    expect((await kit.prisma.pendingSlip.findUniqueOrThrow({ where: { id: s.slip.id } })).resolvedAt).toBeNull();
  });

  it('allows overpayment without inflating the player bill share or spending excess elsewhere', async () => {
    const s = await waiting(28400);
    const billShare = await kit.owed(s.code, s.ids[0]);
    expect(billShare).toBeLessThan(28400);
    await slips.resolveWaiting(s.code, s.slip.id, { coversPlayerIds: [s.ids[0]], senderPlayerId: null });
    expect(await kit.prisma.sessionPayment.findMany({where:{sessionId:s.code}})).toEqual([
      expect.objectContaining({playerId:s.ids[0],amountSatang:billShare,source:'slip'}),
    ]);
    expect(await kit.prisma.pendingSlip.findUniqueOrThrow({where:{id:s.slip.id}})).toMatchObject({reviewedAmountSatang:28400});
  });

  it('requires reviewed amount when OCR found none and validates exact multi-person total', async () => {
    const s = await waiting(null);
    const covers = s.ids.slice(0, 2);
    await conflict(slips.resolveWaiting(s.code, s.slip.id, { coversPlayerIds: covers, senderPlayerId: null }), 'SLIP_AMOUNT_REQUIRED');
    const total = (await kit.owed(s.code, covers[0])) + (await kit.owed(s.code, covers[1]));
    await slips.resolveWaiting(s.code, s.slip.id, { coversPlayerIds: covers, senderPlayerId: null, reviewedAmountSatang: total });
    const marks = await kit.prisma.sessionPayment.findMany({ where: { sessionId: s.code } });
    expect(marks).toHaveLength(2);
    for (const mark of marks) expect(mark.amountSatang).toBe(await kit.owed(s.code, mark.playerId));
    expect(await kit.prisma.pendingSlip.findUniqueOrThrow({ where: { id: s.slip.id } })).toMatchObject({ reviewedAmountSatang: total, reviewedAt: expect.any(Date), resolvedAt: expect.any(Date) });
  });

  it('rejects a player paid elsewhere since review and does not consume slip', async () => {
    const s = await waiting(); await slips.tick(s.code, s.ids[0]);
    await conflict(slips.resolveWaiting(s.code, s.slip.id, { coversPlayerIds: [s.ids[0]], senderPlayerId: null, reviewedAmountSatang: await kit.owed(s.code, s.ids[0]) }), 'PLAYER_ALREADY_PAID');
    expect((await kit.prisma.pendingSlip.findUniqueOrThrow({ where: { id: s.slip.id } })).resolvedAt).toBeNull();
  });

  it('stores readable off-bill amount and private evidence; owner only can view', async () => {
    const s = await kit.setup(owner.id);
    kit.reader.read.mockResolvedValue(slipRead(newRef(), 28400));
    await slips.submitSlip(s.code, s.token, lineUser(), PNG);
    const waiting = await slips.listWaiting(s.code);
    expect(waiting[0].amountSatang).toBe(28400);
    expect(waiting[0].imageId).toEqual(expect.any(String));
    const url = `/sessions/${s.code}/payments/images/${waiting[0].imageId}`;
    await request(kit.server).get(url).expect(401);
    const other = await kit.owner();
    await request(kit.server).get(url).set('Cookie', other.cookie).expect(404);
    const image = await request(kit.server).get(url).set('Cookie', owner.cookie).expect(200);
    expect(image.headers['cache-control']).toBe('no-store');
    expect(image.headers['content-type']).toContain('image/png');
    expect(Buffer.from(image.body)).toEqual(PNG);
    const publicView = await slips.paymentStatusView(s.code, s.token);
    expect(JSON.stringify(publicView)).not.toContain(waiting[0].imageId!);
  });

  it('shows pending only for linked sender whose slip equals their own bill', async () => {
    const s = await kit.setup(owner.id); const user = lineUser();
    await slips.claimPlayer(s.code, user, s.ids[0]);
    const reference = newRef(); const amount = await kit.owed(s.code, s.ids[0]);
    const read = slipRead(reference, amount);
    if (read.kind === 'slip') { read.ocr.text = read.ocr.text.replace('สมหญิง', 'ไม่ใช่ผู้รับ'); read.ocr.lines = read.ocr.lines.map((l) => ({...l,text:l.text.replace('สมหญิง','ไม่ใช่ผู้รับ')})); }
    kit.reader.read.mockResolvedValue(read);
    await slips.submitSlip(s.code, s.token, user, PNG);
    const status = await slips.paymentStatusView(s.code, s.token);
    expect(status?.pendingSlipCount).toBe(1);
    expect(status?.rows.filter((r) => r.pending)).toHaveLength(1);
    await slips.tick(s.code, s.ids[0]);
    expect((await slips.paymentStatusView(s.code, s.token))?.rows.some((r) => r.pending)).toBe(false);
  });

  it('rechecks close state after OCR completes and refuses without saving image', async () => {
    const s = await kit.setup(owner.id);
    for (const id of s.ids) await slips.tick(s.code, id);
    let done!: (r: ReturnType<typeof slipRead>) => void;
    kit.reader.read.mockReturnValue(new Promise((resolve) => { done = resolve; }));
    const uploading = slips.submitSlip(s.code, s.token, lineUser(), PNG);
    while (!done) await new Promise((r) => setTimeout(r, 0));
    await slips.closeCollection(s.code);
    done(slipRead(newRef(), 28400));
    expect(await uploading).toEqual({kind:'unavailable'});
    expect(await kit.prisma.slipImage.count({where:{sessionId:s.code}})).toBe(0);
  });

  it('releases reference after settlement fails even when image cleanup also fails', async () => {
    const s = await kit.setup(owner.id); const ref = newRef();
    kit.reader.read.mockResolvedValue(slipRead(ref, 28400));
    const store = kit.app.get(SlipImagesService);
    const create = vi.spyOn(kit.prisma.pendingSlip, 'create').mockRejectedValueOnce(new Error('database write failed'));
    const remove = vi.spyOn(store, 'removeForReference').mockRejectedValueOnce(new Error('disk deletion failed'));
    await expect(slips.submitSlip(s.code, s.token, lineUser(), PNG)).rejects.toThrow('disk deletion failed');
    expect(await kit.prisma.slipReference.count({where:{groupId:s.groupCode,reference:ref}})).toBe(0);
    create.mockRestore(); remove.mockRestore();
    expect((await slips.submitSlip(s.code, s.token, lineUser(), PNG)).kind).toBe('waiting');
    expect(await kit.prisma.slipImage.count({where:{sessionId:s.code}})).toBe(1);
  });

  it('blocks close until paid and reviews complete, then deletes images and preserves records', async () => {
    const s = await kit.setup(owner.id); const ref = newRef();
    kit.reader.read.mockResolvedValue(slipRead(ref, 28400));
    await slips.submitSlip(s.code, s.token, lineUser(), PNG);
    const pending = (await slips.listWaiting(s.code))[0];
    await conflict(slips.closeCollection(s.code), 'COLLECTION_NOT_READY');
    for (const id of s.ids) await slips.tick(s.code, id);
    await conflict(slips.closeCollection(s.code), 'COLLECTION_NOT_READY');
    await slips.dismissWaiting(s.code, pending.id);
    expect(await slips.collection(s.code)).toMatchObject({ canClose: true, imageCount: 1, closedAt: null });
    await request(kit.server).post(`/sessions/${s.code}/payments/close`).set('Cookie', owner.cookie).send({}).expect(400);
    await request(kit.server).post(`/sessions/${s.code}/payments/close`).set('Cookie', owner.cookie).send({ confirmDeleteImages: true }).expect(200);
    await slips.closeCollection(s.code); // retry after network failure is safe
    expect(await slips.collection(s.code)).toMatchObject({ canClose: false, imageCount: 0, closedAt: expect.any(String) });
    await request(kit.server).get(`/sessions/${s.code}/payments/images/${pending.imageId}`).set('Cookie', owner.cookie).expect(404);
    expect(await kit.prisma.sessionPayment.count({ where: { sessionId: s.code } })).toBe(4);
    expect(await kit.prisma.slipReference.count({ where: { groupId: s.groupCode, reference: ref } })).toBe(1);
    expect(await slips.submitSlip(s.code, s.token, lineUser(), PNG)).toEqual({ kind: 'unavailable' });
    expect(await slips.claimForPayPage(s.code, s.token, lineUser(), s.ids[0])).toBeNull();
    await conflict(slips.untick(s.code, s.ids[0]), 'COLLECTION_CLOSED');
    await conflict(kit.app.get(BillService).setBillConfig(s.code, {} as never), 'COLLECTION_CLOSED');
    await conflict(kit.app.get(SessionsService).setShuttleDetails(s.code, {shuttleCount: 20}), 'COLLECTION_CLOSED');
    await conflict(kit.app.get(SessionsService).setRosterWalkIn(s.code, s.ids[0], {walkIn:true}), 'COLLECTION_CLOSED');
    const oldToken = (await kit.prisma.session.findUniqueOrThrow({where:{code:s.code}})).paymentCard;
    await conflict(kit.cards.confirm(s.code, {expectedHash:'x',bank:'กสิกร',number:'1234567890',name:'สมหญิง'}), 'COLLECTION_CLOSED');
    expect((await kit.prisma.session.findUniqueOrThrow({where:{code:s.code}})).paymentCard).toBe(oldToken);
    expect(await slips.paymentStatusView(s.code, s.token)).toMatchObject({ closedAt: expect.any(String), rows: expect.arrayContaining([expect.objectContaining({ paid: true })]) });
  });
});
