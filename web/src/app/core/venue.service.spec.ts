import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { VenueService, type VenueSearchResult } from './venue.service';
import { environment } from '../../environments/environment';

describe('VenueService', () => {
  let service: VenueService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(VenueService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('search sends the typed text as the q parameter, encoded', () => {
    let result: VenueSearchResult | undefined;
    service.search('สนาม A&B').subscribe((r) => (result = r));
    const req = httpMock.expectOne(
      (r) => r.method === 'GET' && r.url === `${environment.apiBaseUrl}/venues/search`
    );
    expect(req.request.params.get('q')).toBe('สนาม A&B');
    expect(req.request.urlWithParams).toContain('q=%E0%B8%AA');
    req.flush({ exact: null, suggestions: [{ id: '1', displayName: 'KIP' }] });
    expect(result).toEqual({ exact: null, suggestions: [{ id: '1', displayName: 'KIP' }] });
  });
});
