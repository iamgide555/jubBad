import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { RosterService } from './roster.service';
import { environment } from '../../environments/environment';

describe('RosterService', () => {
  let service: RosterService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(RosterService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('getGroup requests GET /groups/:code', () => {
    let result: unknown;
    service.getGroup('group1').subscribe((g) => (result = g));

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/groups/group1`);
    expect(req.request.method).toBe('GET');
    req.flush({ code: 'group1', name: 'Group A', lastSessionCode: null });

    expect(result).toEqual({ code: 'group1', name: 'Group A', lastSessionCode: null });
  });

  it('renameGroup sends PUT /groups/:code with just the new name', () => {
    let result: unknown;
    service.renameGroup('group1', 'New Name').subscribe((g) => (result = g));

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/groups/group1`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ name: 'New Name' });
    req.flush({ code: 'group1', name: 'New Name' });

    expect(result).toEqual({ code: 'group1', name: 'New Name' });
  });

  it('getPlayers requests GET /groups/:code/players', () => {
    let result: unknown;
    service.getPlayers('group1').subscribe((p) => (result = p));

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/groups/group1/players`);
    expect(req.request.method).toBe('GET');
    req.flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);

    expect(result).toEqual([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
  });

  it('createSession sends POST /sessions with the given body', () => {
    let result: unknown;
    const dto = {
      groupCode: 'group1',
      date: '2026-09-08',
      venue: 'KIP',
      courtCount: 2,
      rawImportText: '1. ตั้ม',
      rosterReviews: [],
      waitlistReviews: [],
    };
    service.createSession(dto).subscribe((r) => (result = r));

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/sessions`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(dto);
    req.flush({ code: 'sess1' });

    expect(result).toEqual({ code: 'sess1' });
  });

  it('parseRoster sends POST /groups/:code/parse', () => {
    let result: unknown;
    service.parseRoster('group1', 'Group A', '1. ตั้ม').subscribe((r) => (result = r));

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/groups/group1/parse`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ groupName: 'Group A', rawText: '1. ตั้ม' });
    const response = {
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: [{ inputName: 'ตั้ม', match: { type: 'new' } }],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    };
    req.flush(response);

    expect(result).toEqual(response);
  });
});
