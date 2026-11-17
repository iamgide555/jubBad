import { mailtoUrl, resetEmail } from './reset-email';

const LINK = 'https://jubbad.example/reset/TOKEN123';

describe('resetEmail', () => {
  it.each(['th', 'en'] as const)('names the account, carries the link and says it works once for an hour (%s)', (lang) => {
    const { subject, body } = resetEmail('host@example.test', LINK, lang);
    expect(subject.length).toBeGreaterThan(5);
    expect(body).toContain('host@example.test');
    expect(body).toContain(LINK);
    expect(body).toMatch(lang === 'th' ? /1 ชั่วโมง/ : /1 hour/);
    expect(body).toMatch(lang === 'th' ? /ครั้งเดียว/ : /once/);
  });

  it.each(['th', 'en'] as const)('says to ignore it if the person did not ask (%s)', (lang) => {
    expect(resetEmail('a@b.test', LINK, lang).body).toMatch(lang === 'th' ? /ไม่ได้เป็นผู้ขอ/ : /did not ask|didn't ask/);
  });

  it.each(['th', 'en'] as const)('suggests linking LINE so next time they can reset it themselves (%s)', (lang) => {
    expect(resetEmail('a@b.test', LINK, lang).body).toContain('LINE');
  });

  it('is Thai for th and English for en', () => {
    expect(resetEmail('a@b.test', LINK, 'th').subject).toMatch(/[฀-๿]/);
    expect(resetEmail('a@b.test', LINK, 'en').subject).not.toMatch(/[฀-๿]/);
  });
});

describe('mailtoUrl', () => {
  it('addresses the account and encodes the subject and the whole body, link included', () => {
    const draft = resetEmail('host+tag@example.test', LINK, 'en');
    const url = mailtoUrl('host+tag@example.test', draft);
    expect(url.startsWith('mailto:host%2Btag%40example.test?')).toBe(true);
    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(query.get('subject')).toBe(draft.subject);
    expect(query.get('body')).toBe(draft.body);
  });
});
