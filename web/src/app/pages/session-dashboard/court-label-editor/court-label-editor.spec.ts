import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { environment } from '../../../../environments/environment';
import { LiveSessionService } from '../../../core/live-session.service';
import { CourtLabelEditor } from './court-label-editor';

const B = environment.apiBaseUrl;

describe('CourtLabelEditor', () => {
  let fixture: ComponentFixture<CourtLabelEditor>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CourtLabelEditor],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        LiveSessionService,
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } },
        },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CourtLabelEditor);
    fixture.componentRef.setInput('courtNumber', 2);
    fixture.componentRef.setInput('labels', [null, 'หน้า']);
    fixture.detectChanges();
  });

  afterEach(() => {
    // The service's own session poll is not what these tests are about.
    httpMock.match(`${B}/sessions/sess1`);
    httpMock.verify();
  });

  const el = () => fixture.nativeElement as HTMLElement;
  const button = (name: string) =>
    [...el().querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name
    );
  const input = () => el().querySelector('input') as HTMLInputElement | null;

  function open() {
    button('เปลี่ยนชื่อคอร์ท หน้า')!.click();
    fixture.detectChanges();
  }

  function type(value: string) {
    const i = input()!;
    i.value = value;
    i.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  it('shows an accessible, tap-sized edit button and no field until opened', () => {
    const edit = button('เปลี่ยนชื่อคอร์ท หน้า');
    expect(edit).toBeTruthy();
    expect(edit!.classList).toContain('ghost');
    expect(input()).toBeNull();
  });

  it('opens a one-line field prefilled with the label, placeholder showing the number', () => {
    open();
    expect(input()!.value).toBe('หน้า');
    expect(input()!.getAttribute('placeholder')).toBe('2');
    expect(input()!.getAttribute('aria-label')).toBe('ชื่อคอร์ท 2');
    expect(input()!.getAttribute('maxlength')).toBe('30');
  });

  it('saves a custom name to this court and closes', async () => {
    open();
    type('สนาม 7');
    button('บันทึก')!.click();
    const req = httpMock.expectOne(`${B}/sessions/sess1/courts/2/label`);
    expect(req.request.body).toEqual({ label: 'สนาม 7' });
    req.flush({ code: 'sess1', courtNumber: 2, label: 'สนาม 7' });
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
    expect(input()).toBeNull();
  });

  it('a blank save sends an empty label to reset to the number', async () => {
    open();
    type('   ');
    button('บันทึก')!.click();
    const req = httpMock.expectOne(`${B}/sessions/sess1/courts/2/label`);
    expect(req.request.body).toEqual({ label: '' });
    req.flush({ code: 'sess1', courtNumber: 2, label: null });
    await new Promise((r) => setTimeout(r, 0));
  });

  it('cancel closes without a request', () => {
    open();
    type('X');
    button('ยกเลิก')!.click();
    fixture.detectChanges();
    expect(input()).toBeNull();
    httpMock.expectNone(`${B}/sessions/sess1/courts/2/label`);
  });

  it('a conflict keeps the draft open and shows a localized error', async () => {
    open();
    type('1');
    button('บันทึก')!.click();
    httpMock
      .expectOne(`${B}/sessions/sess1/courts/2/label`)
      .flush({ code: 'COURT_LABEL_CONFLICT' }, { status: 409, statusText: 'Conflict' });
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
    expect(input()!.value).toBe('1');
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('ชื่อคอร์ทนี้ซ้ำกับคอร์ทอื่น');
  });
});
