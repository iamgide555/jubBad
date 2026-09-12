import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AdminService } from './admin.service';
import { environment } from '../../environments/environment';

const B = environment.apiBaseUrl;

describe('AdminService', () => {
  let service: AdminService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AdminService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('lists users', () => {
    service.listUsers().subscribe();
    const req = httpMock.expectOne(`${B}/admin/users`);
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('creates a user, defaulting to the host role', () => {
    service.createUser('new@example.test', 'a password').subscribe();
    const req = httpMock.expectOne(`${B}/admin/users`);
    expect(req.request.body).toEqual({
      email: 'new@example.test',
      password: 'a password',
      role: 'host',
    });
    req.flush({});
  });

  it('sends a delete with the disposition as the request body', () => {
    service
      .deleteUser('user-1', {
        g1: { action: 'delete' },
        g2: { action: 'reassign', toUserId: 'user-2' },
      })
      .subscribe();
    const req = httpMock.expectOne(`${B}/admin/users/user-1`);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.body).toEqual({
      groups: { g1: { action: 'delete' }, g2: { action: 'reassign', toUserId: 'user-2' } },
    });
    req.flush({ deleted: true });
  });

  it('mints a reset token', () => {
    service.resetUserPassword('user-1').subscribe();
    const req = httpMock.expectOne(`${B}/admin/users/user-1/reset`);
    expect(req.request.method).toBe('POST');
    req.flush({ token: 'abc' });
  });

  it('reassigns a group owner', () => {
    service.reassignGroupOwner('g1', 'user-2').subscribe();
    const req = httpMock.expectOne(`${B}/admin/groups/g1/owner`);
    expect(req.request.body).toEqual({ toUserId: 'user-2' });
    req.flush({});
  });

  it('handles a reset request', () => {
    service.handleResetRequest('req-1').subscribe();
    const req = httpMock.expectOne(`${B}/admin/reset-requests/req-1/handle`);
    expect(req.request.method).toBe('POST');
    req.flush({ handled: true });
  });
});
