import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { environment } from '../../../environments/environment';
import { VenueSearch } from './venue-search';

@Component({
  imports: [VenueSearch],
  template: `<app-venue-search [(value)]="venue" />`,
})
class Host {
  readonly venue = signal('');
}

const URL = `${environment.apiBaseUrl}/venues/search`;

describe('VenueSearch', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let httpMock: HttpTestingController;

  const input = () => fixture.nativeElement.querySelector('input') as HTMLInputElement;
  const options = () => [...fixture.nativeElement.querySelectorAll('.venue-option')] as HTMLButtonElement[];
  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const requests = () => httpMock.match((r) => r.url === URL);

  beforeEach(async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates the bound value on every keystroke, before any search', () => {
    type('ki');
    expect(host.venue()).toBe('ki');
    expect(requests()).toHaveLength(0);
  });

  it('searches once, 250 ms after typing stops', () => {
    type('k');
    vi.advanceTimersByTime(200);
    type('ki');
    vi.advanceTimersByTime(249);
    expect(requests()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    const reqs = requests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].request.params.get('q')).toBe('ki');
  });

  it('lists the exact venue first, then suggestions, as buttons', () => {
    type('kip');
    vi.advanceTimersByTime(250);
    requests()[0].flush({
      exact: { id: '1', displayName: 'KIP' },
      suggestions: [{ id: '2', displayName: 'KIP Complex' }],
    });
    fixture.detectChanges();
    expect(options().map((b) => b.textContent!.trim())).toEqual(['KIP', 'KIP Complex']);
  });

  it('tapping an option sets the value, closes the list and does not search again', () => {
    type('ki');
    vi.advanceTimersByTime(250);
    requests()[0].flush({ exact: null, suggestions: [{ id: '2', displayName: 'KIP Complex' }] });
    fixture.detectChanges();

    options()[0].click();
    fixture.detectChanges();
    expect(host.venue()).toBe('KIP Complex');
    expect(options()).toHaveLength(0);
    vi.advanceTimersByTime(500);
    expect(requests()).toHaveLength(0);
  });

  it('shows no list and sends no request for a blank value', () => {
    type('ki');
    vi.advanceTimersByTime(250);
    requests()[0].flush({ exact: null, suggestions: [{ id: '2', displayName: 'KIP Complex' }] });
    fixture.detectChanges();
    expect(options()).toHaveLength(1);

    type('  ');
    vi.advanceTimersByTime(500);
    fixture.detectChanges();
    expect(options()).toHaveLength(0);
    expect(requests()).toHaveLength(0);
  });

  it('leaves the typed value and an empty list when the search fails', () => {
    type('ki');
    vi.advanceTimersByTime(250);
    requests()[0].flush('boom', { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();
    expect(host.venue()).toBe('ki');
    expect(options()).toHaveLength(0);
  });

  it('ignores a slow answer for text that is no longer in the box', () => {
    type('ki');
    vi.advanceTimersByTime(250);
    const first = requests()[0];
    type('mama');
    first.flush({ exact: null, suggestions: [{ id: '2', displayName: 'KIP Complex' }] });
    fixture.detectChanges();
    expect(options()).toHaveLength(0);
  });

  it('searches a value filled in from outside, such as a parsed venue', () => {
    host.venue.set('KIP');
    fixture.detectChanges();
    vi.advanceTimersByTime(250);
    expect(requests()[0].request.params.get('q')).toBe('KIP');
  });
});
