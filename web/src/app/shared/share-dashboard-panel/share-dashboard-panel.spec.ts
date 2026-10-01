import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ShareDashboardPanel } from './share-dashboard-panel';
import { environment } from '../../../environments/environment';

const URL = `${environment.apiBaseUrl}/groups/g1/share`;

describe('ShareDashboardPanel', () => {
  let fixture: ComponentFixture<ShareDashboardPanel>;
  let httpMock: HttpTestingController;

  const tick = async () => {
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  };
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (name: string) => el().querySelector<HTMLButtonElement>(`[data-${name}]`);

  async function open(initial: { token: string | null } | 'missing') {
    await TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ShareDashboardPanel);
    fixture.componentRef.setInput('groupCode', 'g1');
    fixture.detectChanges();
    const req = httpMock.expectOne(URL);
    expect(req.request.method).toBe('GET');
    if (initial === 'missing') req.flush('Not Found', { status: 404, statusText: 'Not Found' });
    else req.flush(initial);
    await tick();
  }

  afterEach(() => httpMock.verify());

  it('offers to share when nothing is shared yet', async () => {
    await open({ token: null });
    expect(button('share')).not.toBeNull();
    expect(el().querySelector('[data-link]')).toBeNull();
  });

  it('says it is unavailable for a group that does not exist yet', async () => {
    await open('missing');
    expect(button('share')).toBeNull();
    expect(el().querySelector('[data-unavailable]')).not.toBeNull();
  });

  it('creates the link, then shows it with copy and stop controls', async () => {
    await open({ token: null });
    button('share')!.click();
    const post = httpMock.expectOne(URL);
    expect(post.request.method).toBe('POST');
    post.flush({ token: 'tok123' });
    await tick();
    const input = el().querySelector<HTMLInputElement>('[data-link]')!;
    expect(input.value).toMatch(/\/d\/tok123$/);
    expect(input.readOnly).toBe(true);
    expect(button('copy')).not.toBeNull();
    expect(button('stop')).not.toBeNull();
  });

  it('copies the link and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await open({ token: 'tok123' });
    button('copy')!.click();
    await tick();
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/d\/tok123$/));
    expect(el().querySelector('[data-copied]')).not.toBeNull();
  });

  it('tells the host to copy by hand when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    await open({ token: 'tok123' });
    button('copy')!.click();
    await tick();
    expect(el().querySelector('[data-copy-failed]')).not.toBeNull();
    expect(el().querySelector('[data-copied]')).toBeNull();
  });

  it('asks for confirmation before stopping, then clears the link', async () => {
    await open({ token: 'tok123' });
    button('stop')!.click();
    fixture.detectChanges();
    httpMock.expectNone(URL); // first tap only asks
    expect(button('confirm-stop')).not.toBeNull();

    button('confirm-stop')!.click();
    const del = httpMock.expectOne(URL);
    expect(del.request.method).toBe('DELETE');
    del.flush({ token: null });
    await tick();
    expect(el().querySelector('[data-link]')).toBeNull();
    expect(button('share')).not.toBeNull();
  });

  it('lets the host back out of stopping', async () => {
    await open({ token: 'tok123' });
    button('stop')!.click();
    fixture.detectChanges();
    button('cancel-stop')!.click();
    fixture.detectChanges();
    expect(button('confirm-stop')).toBeNull();
    expect(el().querySelector('[data-link]')).not.toBeNull();
  });

  it('shows an error and keeps the old state when sharing fails', async () => {
    await open({ token: null });
    button('share')!.click();
    httpMock.expectOne(URL).flush('boom', { status: 500, statusText: 'Server Error' });
    await tick();
    expect(el().querySelector('[role="alert"]')).not.toBeNull();
    expect(button('share')).not.toBeNull();
  });
});
