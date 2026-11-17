/**
 * A ready-to-send email carrying a password-reset link, for the admin to paste into their own mail app. The server
 * cannot send email, so a host who never linked LINE is reached this way. Both languages are always offered and the
 * words are fixed (not the admin's UI locale), because the reader is the host, not the admin.
 */
export type EmailLang = 'th' | 'en';

export interface EmailDraft {
  subject: string;
  body: string;
}

export function resetEmail(email: string, link: string, lang: EmailLang): EmailDraft {
  if (lang === 'th') {
    return {
      subject: 'ลิงก์ตั้งรหัสผ่านใหม่ JubBad',
      body: [
        'สวัสดี',
        '',
        `ตามที่ขอตั้งรหัสผ่านใหม่สำหรับบัญชี JubBad (${email}) กดลิงก์นี้เพื่อตั้งรหัสผ่านใหม่:`,
        link,
        '',
        'ลิงก์ใช้ได้ครั้งเดียวและหมดอายุใน 1 ชั่วโมง หากไม่ได้เป็นผู้ขอ ไม่ต้องทำอะไร',
        '',
        'เคล็ดลับ: ผูกบัญชี LINE กับ JubBad แล้วคราวหน้าตั้งรหัสผ่านใหม่เองได้ทางแชตบอท',
      ].join('\n'),
    };
  }
  return {
    subject: 'Your JubBad password reset link',
    body: [
      'Hello,',
      '',
      `You asked to set a new password for your JubBad account (${email}). Open this link to set it:`,
      link,
      '',
      'The link works once and expires in 1 hour. If you did not ask for this, you can ignore it.',
      '',
      'Tip: link your LINE account to JubBad and next time you can reset your password yourself in the bot chat.',
    ].join('\n'),
  };
}

/** A mailto: link that opens the draft in the mail app, addressed to the account. Everything is URL-encoded. */
export function mailtoUrl(email: string, draft: EmailDraft): string {
  const query = `subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
  return `mailto:${encodeURIComponent(email)}?${query}`;
}
