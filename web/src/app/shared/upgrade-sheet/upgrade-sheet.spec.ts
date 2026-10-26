import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UpgradeSheetService } from '../../core/upgrade-sheet.service';
import { UpgradeSheet } from './upgrade-sheet';

// jsdom 28's HTMLDialogElement has no showModal()/close(); same shim as the other dialog specs.
beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
});

describe('UpgradeSheet', () => {
  let fixture: ComponentFixture<UpgradeSheet>;
  const isOpen = signal(false);
  const contactUrl = signal<string | null>(null);
  const close = vi.fn(() => isOpen.set(false));

  const el = () => fixture.nativeElement as HTMLElement;
  const dialog = () => el().querySelector('dialog') as HTMLDialogElement;

  beforeEach(async () => {
    isOpen.set(false);
    contactUrl.set(null);
    close.mockClear();
    TestBed.configureTestingModule({
      providers: [{ provide: UpgradeSheetService, useValue: { isOpen, contactUrl, close, open: vi.fn() } }],
    });
    fixture = TestBed.createComponent(UpgradeSheet);
    fixture.detectChanges();
  });

  async function open() {
    isOpen.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  it('is a closed dialog until the service opens it', () => {
    expect(dialog().open).toBe(false);
  });

  it('lists what the Host plan adds, in five lines', async () => {
    await open();
    expect(dialog().open).toBe(true);
    expect(el().querySelectorAll('.benefit').length).toBe(5);
    expect(el().textContent).toContain('สร้างได้ 3 ก๊วน');
  });

  it('links to the contact in a new tab when the server gave an https link', async () => {
    contactUrl.set('https://line.me/R/ti/p/@jubbad');
    await open();
    const a = el().querySelector('a.contact') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://line.me/R/ti/p/@jubbad');
    expect(a.target).toBe('_blank');
    expect(a.rel).toContain('noopener');
  });

  it('shows text only, no link, when there is no contact link', async () => {
    await open();
    expect(el().querySelector('a.contact')).toBeNull();
    expect(el().textContent).toContain('ติดต่อทีม JubBad เพื่ออัปเกรด');
  });

  it('closes from the close button and from Escape', async () => {
    await open();
    (el().querySelector('button.close') as HTMLButtonElement).click();
    expect(close).toHaveBeenCalledTimes(1);
    await open();
    dialog().dispatchEvent(new Event('close'));
    expect(close).toHaveBeenCalledTimes(2);
  });
});
