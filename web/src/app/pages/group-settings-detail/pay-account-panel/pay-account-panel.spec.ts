import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { environment } from '../../../../environments/environment';
import { PayAccountPanel } from './pay-account-panel';

const URL = `${environment.apiBaseUrl}/groups/group1/pay-account`;
const ACCOUNT = { bank: 'กสิกร', number: '123-4-56789-0', name: 'สมชาย ใจดี' };

describe('PayAccountPanel', () => {
  let fixture: ComponentFixture<PayAccountPanel>;
  let httpMock: HttpTestingController;

  const tick = async () => {
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  };
  const el = () => fixture.nativeElement as HTMLElement;
  const q = (selector: string) => el().querySelector<HTMLElement>(selector);
  const bank = () => q('#pay-bank') as HTMLInputElement;
  const number = () => q('#pay-number') as HTMLInputElement;
  const name = () => q('#pay-name') as HTMLInputElement;
  const error = () => q('[data-pay-error]')?.textContent?.trim();

  async function open(initial: { account: typeof ACCOUNT | null } | 'failed' = { account: null }) {
    await TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PayAccountPanel);
    fixture.componentRef.setInput('groupCode', 'group1');
    fixture.detectChanges();
    const req = httpMock.expectOne(URL);
    expect(req.request.method).toBe('GET');
    if (initial === 'failed') req.flush('x', { status: 500, statusText: 'x' });
    else req.flush(initial);
    await tick();
  }

  async function fill(input: HTMLInputElement, value: string) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  afterEach(() => httpMock.verify());

  it('loads the saved account into the three fields', async () => {
    await open({ account: ACCOUNT });
    expect(bank().value).toBe('กสิกร');
    expect(number().value).toBe('123-4-56789-0');
    expect(name().value).toBe('สมชาย ใจดี');
  });

  it('starts empty when nothing is saved, with no clear button', async () => {
    await open();
    expect(bank().value).toBe('');
    expect(number().value).toBe('');
    expect(name().value).toBe('');
    expect(q('[data-pay-clear]')).toBeNull();
  });

  it('the number field asks for the numeric keypad', async () => {
    await open();
    expect(number().getAttribute('inputmode')).toBe('numeric');
    expect(number().getAttribute('autocomplete')).toBe('off');
  });

  it('shows a retry when the saved account cannot be read', async () => {
    await open('failed');
    expect(q('[data-pay-load-failed]')).not.toBeNull();
    expect(q('[data-pay-save]')).toBeNull();
  });

  it('a partial entry shows the validation message and never calls the API', async () => {
    await open();
    await fill(bank(), 'กสิกร');
    q('[data-pay-save]')!.click();
    await tick();
    expect(error()).toContain('กรอกให้ครบทั้งสามช่อง');
    expect(bank().hasAttribute('aria-invalid')).toBe(false);
    for (const field of [number(), name()]) {
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(q(`#${field.getAttribute('aria-describedby')}`)?.textContent).toBeTruthy();
    }
    httpMock.expectNone(URL);
  });

  it('a number with too few digits is refused before the API', async () => {
    await open();
    await fill(bank(), 'กสิกร');
    await fill(number(), '--- 12 ---');
    await fill(name(), 'สมชาย');
    q('[data-pay-save]')!.click();
    await tick();
    expect(error()).toContain('เลขบัญชี');
    expect(number().getAttribute('aria-invalid')).toBe('true');
    expect(q(`#${number().getAttribute('aria-describedby')}`)?.textContent).toContain('เลขบัญชี');
    httpMock.expectNone(URL);
  });

  it('a number with letters is refused before the API', async () => {
    await open();
    await fill(bank(), 'กสิกร');
    await fill(number(), '12345abc');
    await fill(name(), 'สมชาย');
    q('[data-pay-save]')!.click();
    await tick();
    expect(error()).toContain('เลขบัญชี');
    httpMock.expectNone(URL);
  });

  it('saves all three with PUT, trimmed, and says so', async () => {
    await open();
    await fill(bank(), ' กสิกร ');
    await fill(number(), ' 123-4-56789-0 ');
    await fill(name(), ' สมชาย ใจดี ');
    q('[data-pay-save]')!.click();
    const req = httpMock.expectOne({ url: URL, method: 'PUT' });
    expect(req.request.body).toEqual(ACCOUNT);
    req.flush({ account: ACCOUNT });
    await tick();
    expect(q('[data-pay-saved]')?.textContent).toContain('บันทึกแล้ว');
    expect(error()).toBeUndefined();
    expect(q('[data-pay-clear]')).not.toBeNull();
  });

  it('accepts a pasted number with spaces and dashes as typed', async () => {
    await open();
    await fill(bank(), 'PromptPay');
    await fill(number(), '081 234-5678');
    await fill(name(), 'สมชาย');
    q('[data-pay-save]')!.click();
    const req = httpMock.expectOne({ url: URL, method: 'PUT' });
    expect(req.request.body).toEqual({ bank: 'PromptPay', number: '081 234-5678', name: 'สมชาย' });
    req.flush({ account: { bank: 'PromptPay', number: '081 234-5678', name: 'สมชาย' } });
    await tick();
  });

  it('picking a bank from the list fills the field that is saved', async () => {
    await open();
    bank().dispatchEvent(new Event('focus'));
    fixture.detectChanges();
    const options = [...el().querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options).toHaveLength(12);
    options[4].click();
    fixture.detectChanges();
    expect(bank().value).toBe('ไทยพาณิชย์');
    await fill(number(), '1234567890');
    await fill(name(), 'สมชาย');
    q('[data-pay-save]')!.click();
    const req = httpMock.expectOne({ url: URL, method: 'PUT' });
    expect(req.request.body.bank).toBe('ไทยพาณิชย์');
    req.flush({ account: req.request.body });
    await tick();
  });

  it('requires inline confirmation before removing the account', async () => {
    await open({ account: ACCOUNT });
    q('[data-pay-clear]')!.click();
    await tick();
    httpMock.expectNone(URL);
    expect(q('[data-pay-clear-confirm]')).not.toBeNull();
    q('[data-pay-clear-cancel]')!.click();
    await tick();
    expect(bank().value).toBe(ACCOUNT.bank);
    expect(q('[data-pay-clear-confirm]')).toBeNull();
    q('[data-pay-clear]')!.click();
    await tick();
    q('[data-pay-clear-confirm]')!.click();
    const req = httpMock.expectOne({ url: URL, method: 'PUT' });
    expect(req.request.body).toEqual({ bank: '', number: '', name: '' });
    req.flush({ account: null });
    await tick();
    expect(bank().value).toBe('');
    expect(number().value).toBe('');
    expect(name().value).toBe('');
    expect(q('[data-pay-clear]')).toBeNull();
    expect(q('[data-pay-saved]')?.textContent).toContain('ล้างบัญชีแล้ว');
  });

  it('saving with every field blank clears the account too', async () => {
    await open({ account: ACCOUNT });
    await fill(bank(), '');
    await fill(number(), '');
    await fill(name(), '');
    q('[data-pay-save]')!.click();
    const req = httpMock.expectOne({ url: URL, method: 'PUT' });
    expect(req.request.body).toEqual({ bank: '', number: '', name: '' });
    req.flush({ account: null });
    await tick();
  });

  it('shows the validation message when the server answers PAY_ACCOUNT_INVALID', async () => {
    await open();
    await fill(bank(), 'กสิกร');
    await fill(number(), '1234567890');
    await fill(name(), 'สมชาย');
    q('[data-pay-save]')!.click();
    httpMock
      .expectOne({ url: URL, method: 'PUT' })
      .flush({ code: 'PAY_ACCOUNT_INVALID' }, { status: 400, statusText: 'Bad Request' });
    await tick();
    expect(error()).toContain('ตรวจบัญชีรับเงินอีกครั้ง');
    expect(q('[data-pay-saved]')).toBeNull();
  });

  it('shows a generic message for any other failure', async () => {
    await open();
    await fill(bank(), 'กสิกร');
    await fill(number(), '1234567890');
    await fill(name(), 'สมชาย');
    q('[data-pay-save]')!.click();
    httpMock.expectOne({ url: URL, method: 'PUT' }).flush('x', { status: 500, statusText: 'x' });
    await tick();
    expect(error()).toContain('บันทึกไม่สำเร็จ');
  });

  it('editing after a save drops the saved note', async () => {
    await open({ account: ACCOUNT });
    q('[data-pay-save]')!.click();
    httpMock.expectOne({ url: URL, method: 'PUT' }).flush({ account: ACCOUNT });
    await tick();
    expect(q('[data-pay-saved]')).not.toBeNull();
    await fill(name(), 'สมหญิง');
    expect(q('[data-pay-saved]')).toBeNull();
  });
});
