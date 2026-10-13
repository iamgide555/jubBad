# Group Creation and Discoverable Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host saves a group with only a name, finds every group setting beside the group's name, and starts sessions later from a separate roster screen. The UI uses ก๊วน for the group and รอบ for a session everywhere.

**Architecture:** The server gains `POST /groups`, an atomic create-or-read keyed by a client-generated UUID and owned strictly by the caller. Today's single `GroupEntry` page is split into four routed screens:
- `/groups/new` — create a group
- `/g/:groupCode` — new `GroupHome`: header, settings disclosure, sessions
- `/g/:groupCode/settings/:section` — new `GroupSettingsDetail`: share, advanced, manage
- `/g/:groupCode/start` — the existing `GroupEntry`, slimmed to roster entry only

A root-provided, in-memory `RosterDraftService` keeps an unfinished roster alive across route changes.

**Tech Stack:**
- Server: NestJS + Prisma + SQLite, vitest + supertest. Tests run from `server/` with `fileParallelism: false`.
- Web: Angular 22 standalone components with signals, vitest via `ng test`, `@angular/localize` with a Thai source catalogue and an English XLF.

**Spec:** `docs/superpowers/specs/2026-10-13-group-creation-settings-design.md`. Read it before starting any task. Its "Prototype deviations implementers must not copy" table is binding.

## Global Constraints

- New group code format: a full lowercase canonical UUID, `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`. Legacy 8-hex codes stay valid everywhere they are read.
- `POST /groups` never takes an owner from the body. A code owned by anyone else, an admin included, returns 404, never 403.
- A group name is trimmed before validation and stored trimmed. Whitespace-only is rejected. There is no maximum length.
- Duplicate names are allowed. Creating or renaming to a name the host already owns warns once (client-side, own groups only via `GET /groups`) and proceeds on a second submit. Other hosts' names are never checked.
- Controls come from `web/src/styles.css`, not from the prototype:
  - default `button` is filled `--court`; `button.ghost`; `button.danger`
  - the global `:focus-visible` ring; hover only inside `@media (hover: hover)`
  - `.label`, `.muted`, `.error`; inline errors use `role="alert"`
- Every tap target is at least 44px (`--tap`).
- Thai is the i18n source. Every new string gets a stable `@@id` and an English target in `web/src/locale/messages.en.xlf`. One id must never carry two different source texts.
- Vocabulary: ก๊วน names only the reusable group; รอบ names one session; นัด is retired. Idioms kept: `bill.hostFee` (ค่าจัดก๊วนต่อคน) and `admin.roleHost` (ผู้ดูแลก๊วน).
- No application data goes into `localStorage`. The roster draft lives in memory only.
- Every new host route uses `canActivate: [adminGuard]`.
- Server specs must keep `fileParallelism: false`. Never re-enable parallelism.
- Do not mount `<app-scene-host>` on any new screen. Group home is a working screen, not a hero screen.

## Review Focus

1. **A double-tapped Create, or a retry after a lost response.** The host expects exactly one group. Two concurrent `POST /groups` calls with the same code and owner both succeed and leave one row. The test lives in Task 1.
2. **A bookmarked legacy 8-hex group URL.** The host expects it to open, rename and start sessions exactly as before. Home and start screens load an 8-hex code, and `POST /groups` rejects one. Tests in Tasks 1 and 5.
3. **Opening `/g/:code` for a group that is deleted or not theirs.** The host expects "not found", never a blank group they could start filling in. A 404 shows the not-found state with no settings and no start button. Test in Task 5.
4. **A settings value fetch fails.** The host expects the row's plain description, never a made-up "0 คน" or "ยังไม่แชร์". Test in Task 5.
5. **A host types a name they already use.** The host expects a heads-up with a link to the existing group, never a block, and never a warning caused by another host's group. Tests in Tasks 2, 3 and 4.
6. **A pasted roster, then a detour through settings and back.** The host expects the roster still there, and gone once the session is created. Tests in Task 6.

---

## File Structure

**Server**
- Create `server/src/groups/dto/create-group.dto.ts`: the new group's code and trimmed name.
- Create `server/src/groups/dto/trim.ts`: a shared trim transform used by create and rename.
- Modify `server/src/groups/dto/update-group.dto.ts`: trim the name.
- Modify `server/src/groups/groups.service.ts`: add `create()`, the atomic create-or-read.
- Modify `server/src/groups/groups.controller.ts`: add `@Post()`.
- Modify `server/src/auth/ownership.guard.ts`: comment only, to say `POST /groups` reaches the service unchecked.
- Create `server/src/groups/create-group.spec.ts`.
- Modify `server/src/auth/auth.boundary.spec.ts` and `server/src/groups/groups.controller.spec.ts`.

**Web: core**
- Modify `web/src/app/core/roster.service.ts`: add `createGroup`, `getShare`.
- Create `web/src/app/core/settings-sections.ts`: section names and type guards.
- Create `web/src/app/core/roster-draft.service.ts` and its spec.
- Modify `web/src/app/shared/icon/icon.ts`: add the `gear` glyph.

**Web: pages**
- Create `web/src/app/pages/group-create/group-create.{ts,html,css,spec.ts}`.
- Create `web/src/app/pages/group-home/group-home.{ts,html,css,spec.ts}`.
- Create `web/src/app/pages/group-settings-detail/group-settings-detail.{ts,html,css,spec.ts}`.
- Modify `web/src/app/pages/group-entry/group-entry.{ts,html,css,spec.ts}`: roster entry only.
- Modify `web/src/app/pages/landing/landing.{ts,spec.ts}`: create navigates to `/groups/new`.
- Modify `web/src/app/pages/player-roster/player-roster.html` and `web/src/app/pages/group-levels/group-levels.html`: back links.
- Modify `web/src/app/app.routes.ts` and `web/src/app/app.routes.spec.ts`.
- Modify `web/src/locale/messages.xlf` (regenerated) and `web/src/locale/messages.en.xlf`.

**Docs**
- Modify `CLAUDE.md`, `docs/overview.md`, `PRODUCT.md`, and the spec's checkboxes. Archive the spec and this plan last.

---

### Task 1: Server — `POST /groups` and trimmed names

**Files:**
- Create: `server/src/groups/dto/trim.ts`
- Create: `server/src/groups/dto/create-group.dto.ts`
- Modify: `server/src/groups/dto/update-group.dto.ts`
- Modify: `server/src/groups/groups.service.ts` (add `create` right after `findOne`, around line 100)
- Modify: `server/src/groups/groups.controller.ts` (add `@Post()` right after `list()`, around line 68)
- Modify: `server/src/auth/ownership.guard.ts` (comment above `if (path === '/' || path === '/groups' || path === '/sessions')`)
- Test: `server/src/groups/create-group.spec.ts` (new), `server/src/groups/groups.controller.spec.ts`, `server/src/auth/auth.boundary.spec.ts`

**Interfaces:**
- Produces: `POST /groups` with body `{ code: string; name: string }`. It responds `201 { code: string; name: string | null }` for a new group, and for a retry of a group the caller already owns. It responds `400` for a bad code or a blank name, `401` when signed out, and `404` when another user owns the code.
- Produces: `GroupsService.create(dto: CreateGroupDto, caller: { id: string; role: string }): Promise<{ code: string; name: string | null }>`.
- Produces: `NEW_GROUP_CODE: RegExp`, exported from `create-group.dto.ts`.

- [ ] **Step 1: Write the failing service and validation tests**

Create `server/src/groups/create-group.spec.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupsModule } from './groups.module.js';

/**
 * POST /groups is the dedicated, name-only way to make a group. The caller is
 * swapped per test through `caller`, standing in for AuthGuard the same way
 * groups.controller.spec.ts does, so these tests stay about creation rules.
 */
describe('POST /groups', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let hostA: string;
  let hostB: string;
  let admin: string;
  let caller: { id: string; role: string };
  const codes: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    const mk = (role: string) =>
      prisma.user.create({ data: { email: `create-group-${role}-${randomUUID()}@example.test`, passwordHash: 'x', role } });
    hostA = (await mk('host')).id;
    hostB = (await mk('host')).id;
    admin = (await mk('admin')).id;
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = caller;
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  beforeEach(() => {
    caller = { id: hostA, role: 'host' };
  });

  afterEach(async () => {
    await prisma.group.deleteMany({ where: { code: { in: codes.splice(0) } } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [hostA, hostB, admin] } } });
    await app.close();
  });

  const fresh = () => {
    const code = randomUUID();
    codes.push(code);
    return code;
  };

  it('creates an owned group from a name alone, with default settings and nothing else', async () => {
    const code = fresh();
    const res = await request(server).post('/groups').send({ code, name: 'ก๊วนอังคาร' }).expect(201);
    expect(res.body).toEqual({ code, name: 'ก๊วนอังคาร' });

    const row = await prisma.group.findUniqueOrThrow({ where: { code } });
    expect(row.ownerId).toBe(hostA);
    expect(row.shuttleToolsEnabled).toBe(false);
    expect(row.crossSessionHistory).toBe(false);
    expect(await prisma.session.count({ where: { groupId: code } })).toBe(0);
    expect(await prisma.player.count({ where: { groupId: code } })).toBe(0);
  });

  it('stores the name trimmed', async () => {
    const code = fresh();
    const res = await request(server).post('/groups').send({ code, name: '  แบดเย็น  ' }).expect(201);
    expect(res.body.name).toBe('แบดเย็น');
  });

  it.each([[''], ['   '], [undefined]])('rejects a blank name (%j)', async (name) => {
    const code = fresh();
    await request(server).post('/groups').send({ code, name }).expect(400);
    expect(await prisma.group.count({ where: { code } })).toBe(0);
  });

  it.each([['abcd1234'], ['ABCDEF12-3456-7890-ABCD-EF1234567890'], ['not-a-code'], ['']])(
    'rejects a code that is not a lowercase full UUID (%s)',
    async (code) => {
      await request(server).post('/groups').send({ code, name: 'X' }).expect(400);
    }
  );

  it('returns the same group on a retry, without renaming it or resetting its settings', async () => {
    const code = fresh();
    await request(server).post('/groups').send({ code, name: 'First' }).expect(201);
    await prisma.group.update({ where: { code }, data: { shuttleToolsEnabled: true } });

    const retry = await request(server).post('/groups').send({ code, name: 'Second' }).expect(201);
    expect(retry.body).toEqual({ code, name: 'First' });
    const row = await prisma.group.findUniqueOrThrow({ where: { code } });
    expect(row.name).toBe('First');
    expect(row.shuttleToolsEnabled).toBe(true);
  });

  it('two simultaneous creates with one code leave exactly one group', async () => {
    const code = fresh();
    const [a, b] = await Promise.all([
      request(server).post('/groups').send({ code, name: 'Tap' }),
      request(server).post('/groups').send({ code, name: 'Tap' }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await prisma.group.count({ where: { code } })).toBe(1);
  });

  it("404s another host's code and leaves that group untouched", async () => {
    const code = fresh();
    await prisma.group.create({ data: { code, name: 'B owns this', ownerId: hostB } });
    await request(server).post('/groups').send({ code, name: 'Stolen' }).expect(404);
    expect((await prisma.group.findUniqueOrThrow({ where: { code } })).name).toBe('B owns this');
  });

  it("404s an admin's create over a code another host owns — creation never claims", async () => {
    caller = { id: admin, role: 'admin' };
    const code = fresh();
    await prisma.group.create({ data: { code, name: 'B owns this', ownerId: hostB } });
    await request(server).post('/groups').send({ code, name: 'Admin' }).expect(404);
    const row = await prisma.group.findUniqueOrThrow({ where: { code } });
    expect(row.ownerId).toBe(hostB);
    expect(row.name).toBe('B owns this');
  });

  it('ignores an owner supplied in the body', async () => {
    const code = fresh();
    await request(server).post('/groups').send({ code, name: 'Mine', ownerId: hostB }).expect(201);
    expect((await prisma.group.findUniqueOrThrow({ where: { code } })).ownerId).toBe(hostA);
  });
});
```

Then add rename-trim tests to `server/src/groups/groups.controller.spec.ts`, directly after the existing `it('rejects an empty name on rename', …)` block:

```ts
  it('rejects a whitespace-only name on rename', async () => {
    const code = randomUUID();
    await prisma.group.create({ data: { code, name: 'X' } });
    try {
      await request(server).put(`/groups/${code}`).send({ name: '   ' }).expect(400);
      expect((await prisma.group.findUniqueOrThrow({ where: { code } })).name).toBe('X');
    } finally {
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('stores a renamed group name trimmed', async () => {
    const code = randomUUID();
    await prisma.group.create({ data: { code, name: 'X' } });
    try {
      const res = await request(server).put(`/groups/${code}`).send({ name: '  Renamed  ' }).expect(200);
      expect(res.body).toEqual({ code, name: 'Renamed' });
    } finally {
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('still renames a legacy 8-hex group', async () => {
    const code = randomUUID().slice(0, 8);
    await prisma.group.create({ data: { code, name: 'Old' } });
    try {
      await request(server).put(`/groups/${code}`).send({ name: 'New' }).expect(200);
    } finally {
      await prisma.group.deleteMany({ where: { code } });
    }
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd server && npx vitest run src/groups/create-group.spec.ts src/groups/groups.controller.spec.ts -t "POST /groups|whitespace-only|trimmed|legacy 8-hex"`

Expected: the `POST /groups` tests fail with 404 (no route). The whitespace-only and trimmed rename tests fail (the name is stored untrimmed). The legacy rename test passes already.

- [ ] **Step 3: Implement the DTOs**

`server/src/groups/dto/trim.ts`:

```ts
/** class-transformer hook: trims strings, passes anything else through for the validators to reject. */
export const trimString = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
```

`server/src/groups/dto/create-group.dto.ts`:

```ts
import { Transform } from 'class-transformer';
import { IsString, Matches, MinLength } from 'class-validator';
import { trimString } from './trim.js';

/**
 * A full lowercase UUID, as `crypto.randomUUID()` makes one. The client reuses one code
 * across retries of the same creation, so it must be too long to collide with another
 * host's group — an 8-hex clash would 404 on every retry with no way out. Legacy 8-hex
 * codes stay valid everywhere else; only creation enforces this.
 */
export const NEW_GROUP_CODE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class CreateGroupDto {
  @IsString()
  @Matches(NEW_GROUP_CODE)
  code!: string;

  /** Trimmed first: `@MinLength(1)` alone accepts "   ". */
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  name!: string;
}
```

Replace `server/src/groups/dto/update-group.dto.ts` with:

```ts
import { Transform } from 'class-transformer';
import { IsString, MinLength } from 'class-validator';
import { trimString } from './trim.js';

export class UpdateGroupDto {
  /** Trimmed exactly like CreateGroupDto.name, so rename and creation accept and store the same names. */
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  name!: string;
}
```

- [ ] **Step 4: Implement the service method**

In `server/src/groups/groups.service.ts`, add `import { Prisma } from '@prisma/client';` and `import type { CreateGroupDto } from './dto/create-group.dto.js';` to the imports. Then add after `findOne`:

```ts
  /**
   * The dedicated, name-only way to make a group (the parse endpoint's
   * create-or-own stays for older clients). Create-or-read: a retry with the
   * same code returns the caller's existing group untouched — no rename, no
   * settings reset — so a double tap or a lost response never makes two.
   *
   * Strictly the caller's own: unlike `parse`, an admin gets no exception
   * here. Creation must never become a way to take over someone else's code,
   * and the 404 matches the rest of the ownership boundary.
   *
   * The upsert is serialized by SQLite; the P2002 branch covers Prisma's
   * read-then-create upsert losing a race on the same fresh code, in which
   * case the row that won is read back and judged the same way.
   */
  async create(dto: CreateGroupDto, caller: Caller) {
    let group: { code: string; name: string | null; ownerId: string | null } | null;
    try {
      group = await this.prisma.group.upsert({
        where: { code: dto.code },
        create: { code: dto.code, name: dto.name, ownerId: caller.id },
        update: {},
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      group = await this.prisma.group.findUnique({ where: { code: dto.code } });
    }
    if (!group || group.ownerId !== caller.id) throw new NotFoundException();
    return { code: group.code, name: group.name };
  }
```

- [ ] **Step 5: Add the controller route**

In `server/src/groups/groups.controller.ts`, import `CreateGroupDto` from `./dto/create-group.dto.js` and add right after `list()`:

```ts
  /**
   * Name-only creation. Not addressed by a :code, so OwnershipGuard passes it
   * like GET /groups; the ownership decision is GroupsService.create's.
   */
  @Post()
  create(@Body() dto: CreateGroupDto, @Req() req: AuthenticatedRequest) {
    return this.groupsService.create(dto, req.user);
  }
```

- [ ] **Step 6: Update the guard comment**

In `server/src/auth/ownership.guard.ts`, replace the comment block directly above `if (path === '/' || path === '/groups' || path === '/sessions') return true;` with:

```ts
    // Addresses no group by URL, so ownership has nothing to check here: GET /
    // (AppController's scaffold route); GET /groups is filtered by owner in
    // GroupsService.listGroups; POST /groups names its new code in the body and
    // GroupsService.create refuses a code the caller does not own (no admin
    // exception there); POST /sessions names its group in the body, checked in
    // SessionsService.createSession, which is the only place that can.
```

- [ ] **Step 7: Add the boundary tests**

In `server/src/auth/auth.boundary.spec.ts`, inside `describe('ownership boundary', …)`, right after the test `"refuses a second host every route that touches the first host's group or session"`, add:

```ts
    it("refuses a second host creating a group over the first host's code", async () => {
      await request(server)
        .post('/groups')
        .set('Cookie', otherCookie)
        .send({ code: ctx.groupCode, name: 'Taken' })
        .expect(404);
      expect((await prisma.group.findUniqueOrThrow({ where: { code: ctx.groupCode } })).name).toBe('Boundary');
    });

    it('lets a host create a group of their own by name alone', async () => {
      const code = randomUUID();
      try {
        const res = await request(server)
          .post('/groups')
          .set('Cookie', otherCookie)
          .send({ code, name: 'ของฉันเอง' })
          .expect(201);
        expect(res.body).toEqual({ code, name: 'ของฉันเอง' });
      } finally {
        await prisma.group.deleteMany({ where: { code } });
      }
    });
```

The anonymous walk already covers `POST /groups` → 401. Confirm that by running it.

- [ ] **Step 8: Run the tests and confirm they pass**

Run: `cd server && npx vitest run src/groups/create-group.spec.ts src/groups/groups.controller.spec.ts src/auth/auth.boundary.spec.ts src/auth/ownership.guard.spec.ts`
Expected: PASS, all files.

Then run the full server suite and lint: `cd server && npm test && npm run lint`. Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/groups/dto/trim.ts server/src/groups/dto/create-group.dto.ts server/src/groups/dto/update-group.dto.ts server/src/groups/groups.service.ts server/src/groups/groups.controller.ts server/src/auth/ownership.guard.ts server/src/groups/create-group.spec.ts server/src/groups/groups.controller.spec.ts server/src/auth/auth.boundary.spec.ts
git commit -m "feat(groups): name-only POST /groups, strictly caller-owned; trim group names"
```

---

### Task 2: Web core — API methods, settings sections, roster draft, gear icon

**Files:**
- Modify: `web/src/app/core/roster.service.ts`
- Modify: `web/src/app/core/roster.service.spec.ts`
- Create: `web/src/app/core/settings-sections.ts`
- Create: `web/src/app/core/group-name.ts`
- Create: `web/src/app/core/group-name.spec.ts`
- Create: `web/src/app/core/roster-draft.service.ts`
- Create: `web/src/app/core/roster-draft.service.spec.ts`
- Modify: `web/src/app/shared/icon/icon.ts`

**Interfaces:**
- Produces: `RosterService.createGroup(code: string, name: string): Observable<{ code: string; name: string | null }>`, which posts to `${base}/groups`.
- Produces: `RosterService.getShare(code: string): Observable<{ token: string | null }>`, which gets `${base}/groups/${code}/share`.
- Produces: `RosterService.listGroups(): Observable<OwnGroupRow[]>`, which gets `${base}/groups`. `OwnGroupRow` is `{ code: string; name: string | null; mine?: boolean }`, where `mine` is present only for an admin.
- Produces: `sameGroupName(a: string, b: string): boolean` and `findOwnDuplicate(groups: OwnGroupRow[], name: string, exceptCode?: string): { code: string; name: string } | null`, both in `core/group-name.ts`.
- Produces: `SETTINGS_SECTIONS`, `SettingsSection` (`'players' | 'levels' | 'share' | 'advanced' | 'manage'`), `DetailSection` (`'share' | 'advanced' | 'manage'`), `isSettingsSection(v: string | null): v is SettingsSection`, `isDetailSection(v: string | null): v is DetailSection`, `settingsReturn(groupCode: string, section: SettingsSection): { commands: string[]; queryParams: { settings: SettingsSection } }`.
- Produces: `RosterDraft` and `RosterDraftService` with `get(code): RosterDraft | null`, `save(code, draft): void` and `clear(code): void`.
- Produces: `IconName` gains `'gear'`.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/app/core/roster.service.spec.ts`, inside its top-level `describe`. That file uses `service`, `httpMock` and `environment.apiBaseUrl`; add `const B = environment.apiBaseUrl;` at the top of the file if it is not there:

```ts
  it('createGroup posts the code and name to /groups', () => {
    let body: unknown;
    service.createGroup('11111111-2222-3333-4444-555555555555', 'ก๊วนอังคาร').subscribe((r) => (body = r));
    const req = httpMock.expectOne({ url: `${B}/groups`, method: 'POST' });
    expect(req.request.body).toEqual({ code: '11111111-2222-3333-4444-555555555555', name: 'ก๊วนอังคาร' });
    req.flush({ code: '11111111-2222-3333-4444-555555555555', name: 'ก๊วนอังคาร' });
    expect(body).toEqual({ code: '11111111-2222-3333-4444-555555555555', name: 'ก๊วนอังคาร' });
  });

  it('listGroups reads the caller\'s group list', () => {
    let body: unknown;
    service.listGroups().subscribe((r) => (body = r));
    httpMock.expectOne({ url: `${B}/groups`, method: 'GET' }).flush([{ code: 'g1', name: 'ก๊วนอังคาร' }]);
    expect(body).toEqual([{ code: 'g1', name: 'ก๊วนอังคาร' }]);
  });

  it('getShare reads the share state', () => {
    let body: unknown;
    service.getShare('g1').subscribe((r) => (body = r));
    httpMock.expectOne({ url: `${B}/groups/g1/share`, method: 'GET' }).flush({ token: null });
    expect(body).toEqual({ token: null });
  });
```

Create `web/src/app/core/group-name.spec.ts`:

```ts
import { findOwnDuplicate, sameGroupName } from './group-name';

describe('sameGroupName', () => {
  it('ignores surrounding and repeated whitespace and Latin case', () => {
    expect(sameGroupName('  ก๊วน  อังคาร ', 'ก๊วน อังคาร')).toBe(true);
    expect(sameGroupName('Badminton Club', 'badminton club')).toBe(true);
  });

  it('treats different names as different', () => {
    expect(sameGroupName('ก๊วนอังคาร', 'ก๊วนพุธ')).toBe(false);
  });
});

describe('findOwnDuplicate', () => {
  const groups = [
    { code: 'a', name: 'ก๊วนอังคาร' },
    { code: 'b', name: null },
    { code: 'c', name: 'ของคนอื่น', mine: false },
  ];

  it('finds the caller\'s own group with the same name', () => {
    expect(findOwnDuplicate(groups, ' ก๊วนอังคาร ')).toEqual({ code: 'a', name: 'ก๊วนอังคาร' });
  });

  it('ignores another host\'s group, even with the same name (admin list rows)', () => {
    expect(findOwnDuplicate(groups, 'ของคนอื่น')).toBeNull();
  });

  it('skips the group being renamed', () => {
    expect(findOwnDuplicate(groups, 'ก๊วนอังคาร', 'a')).toBeNull();
  });
});
```

Create `web/src/app/core/roster-draft.service.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { RosterDraftService, type RosterDraft } from './roster-draft.service';

function draft(rawText: string): RosterDraft {
  return {
    state: 'paste',
    rawText,
    date: '',
    venue: '',
    courtCount: null,
    warnings: [],
    unrecognizedLines: [],
    rosterReviews: [],
    waitlistReviews: [],
    players: [],
    manualReviews: new Set(),
    openReviews: new Set(),
    idempotencyKey: null,
  };
}

describe('RosterDraftService', () => {
  let drafts: RosterDraftService;
  beforeEach(() => (drafts = TestBed.inject(RosterDraftService)));

  it('has nothing for a group until something is saved', () => {
    expect(drafts.get('g1')).toBeNull();
  });

  it('keeps one draft per group', () => {
    drafts.save('g1', draft('one'));
    drafts.save('g2', draft('two'));
    expect(drafts.get('g1')?.rawText).toBe('one');
    expect(drafts.get('g2')?.rawText).toBe('two');
  });

  it('clears only the named group', () => {
    drafts.save('g1', draft('one'));
    drafts.save('g2', draft('two'));
    drafts.clear('g1');
    expect(drafts.get('g1')).toBeNull();
    expect(drafts.get('g2')?.rawText).toBe('two');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd web && npx ng test --watch=false --include=src/app/core/roster.service.spec.ts --include=src/app/core/roster-draft.service.spec.ts --include=src/app/core/group-name.spec.ts`
Expected: FAIL. `createGroup`/`getShare`/`listGroups` are not functions, and `roster-draft.service` and `group-name` cannot be resolved.

- [ ] **Step 3: Implement**

In `web/src/app/core/roster.service.ts`, add these methods after `getGroup`:

```ts
  /** Name-only creation. `code` is one UUID per creation attempt, reused for retries. */
  createGroup(code: string, name: string) {
    return this.http.post<{ code: string; name: string | null }>(`${this.base}/groups`, { code, name });
  }

  /** Owner-only: whether the group's public dashboard link exists. */
  getShare(code: string) {
    return this.http.get<{ token: string | null }>(`${this.base}/groups/${code}/share`);
  }

  /** The caller's groups (every group, flagged `mine`, for an admin). Used for the same-name warning. */
  listGroups() {
    return this.http.get<OwnGroupRow[]>(`${this.base}/groups`);
  }
```

Add `import type { OwnGroupRow } from './group-name';` to the top of `roster.service.ts`.

Create `web/src/app/core/group-name.ts`:

```ts
/** One row of GET /groups, as far as the same-name warning needs it. `mine` is present only for an admin. */
export interface OwnGroupRow {
  code: string;
  name: string | null;
  mine?: boolean;
}

/** Trimmed, inner whitespace collapsed, Latin case folded. Thai has no case, so it compares as typed. */
export function sameGroupName(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return norm(a) === norm(b);
}

/**
 * The caller's own group already using `name`, if any. Other hosts' rows (an
 * admin's `mine: false`) never count: the warning must not reveal or depend on
 * anyone else's groups. `exceptCode` skips the group being renamed.
 */
export function findOwnDuplicate(
  groups: readonly OwnGroupRow[],
  name: string,
  exceptCode?: string
): { code: string; name: string } | null {
  const hit = groups.find(
    (g) => g.mine !== false && g.code !== exceptCode && g.name !== null && sameGroupName(g.name, name)
  );
  return hit ? { code: hit.code, name: hit.name! } : null;
}
```

Create `web/src/app/core/settings-sections.ts`:

```ts
/** The group settings list, in its fixed order (spec: Settings contents). */
export const SETTINGS_SECTIONS = ['players', 'levels', 'share', 'advanced', 'manage'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The sections that live at /g/:groupCode/settings/:section; players and levels keep their own routes. */
export const DETAIL_SECTIONS = ['share', 'advanced', 'manage'] as const;
export type DetailSection = (typeof DETAIL_SECTIONS)[number];

export function isSettingsSection(value: string | null): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value ?? '');
}

export function isDetailSection(value: string | null): value is DetailSection {
  return (DETAIL_SECTIONS as readonly string[]).includes(value ?? '');
}

/**
 * Where a settings detail's back link goes: group home with the disclosure
 * reopened and focus on the row the host came from. Group home reads and then
 * drops the `settings` parameter (replaceUrl), so a reload does not reopen it.
 */
export function settingsReturn(groupCode: string, section: SettingsSection) {
  return { commands: ['/g', groupCode], queryParams: { settings: section } };
}
```

Create `web/src/app/core/roster-draft.service.ts`:

```ts
import { Injectable } from '@angular/core';
import type { Player } from '../../../../engines/fuzzy-match.ts';
import type { NameReview } from './roster-review';

/**
 * Everything the roster screen needs to come back exactly as the host left it.
 * The two Sets hold the same NameReview objects as the review arrays, so object
 * identity — which GroupEntry uses to tell manual rows and open questions apart —
 * survives the round trip.
 */
export interface RosterDraft {
  state: 'paste' | 'confirm';
  rawText: string;
  date: string;
  venue: string;
  courtCount: number | null;
  warnings: string[];
  unrecognizedLines: string[];
  rosterReviews: NameReview[];
  waitlistReviews: NameReview[];
  players: Player[];
  manualReviews: Set<NameReview>;
  openReviews: Set<NameReview>;
  idempotencyKey: string | null;
}

/**
 * Keeps an unfinished roster alive while the host steps out to group settings
 * and back. Root-provided and in memory only, keyed by group code: the roster
 * route component is destroyed on navigation, so it cannot hold the draft
 * itself. A reload drops it, as before; nothing goes to localStorage.
 */
@Injectable({ providedIn: 'root' })
export class RosterDraftService {
  private readonly drafts = new Map<string, RosterDraft>();

  get(groupCode: string): RosterDraft | null {
    return this.drafts.get(groupCode) ?? null;
  }

  save(groupCode: string, draft: RosterDraft): void {
    this.drafts.set(groupCode, draft);
  }

  clear(groupCode: string): void {
    this.drafts.delete(groupCode);
  }
}
```

In `web/src/app/shared/icon/icon.ts`, add `| 'gear'` to `IconName`. Then add this case inside the `@switch (name())` block, next to `@case ('chevron')`:

```html
        @case ('gear') {
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"
          />
        }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd web && npx ng test --watch=false --include=src/app/core/roster.service.spec.ts --include=src/app/core/roster-draft.service.spec.ts --include=src/app/core/group-name.spec.ts --include=src/app/shared/icon/icon.spec.ts`
Expected: PASS. If `icon.spec.ts` does not exist, drop that `--include`.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/roster.service.ts web/src/app/core/roster.service.spec.ts web/src/app/core/settings-sections.ts web/src/app/core/group-name.ts web/src/app/core/group-name.spec.ts web/src/app/core/roster-draft.service.ts web/src/app/core/roster-draft.service.spec.ts web/src/app/shared/icon/icon.ts
git commit -m "feat(web): createGroup/getShare/listGroups API, same-name helper, settings sections, roster draft, gear icon"
```

---

### Task 3: Create-group screen at `/groups/new`

**Files:**
- Create: `web/src/app/pages/group-create/group-create.ts`
- Create: `web/src/app/pages/group-create/group-create.html`
- Create: `web/src/app/pages/group-create/group-create.css`
- Create: `web/src/app/pages/group-create/group-create.spec.ts`
- Modify: `web/src/app/app.routes.ts`, `web/src/app/app.routes.spec.ts`
- Modify: `web/src/app/pages/landing/landing.ts` (`startNewGroup`), `web/src/app/pages/landing/landing.spec.ts`

**Interfaces:**
- Consumes: `RosterService.createGroup`, `RosterService.listGroups` and `findOwnDuplicate` (Task 2).
- Produces: route `groups/new` → `GroupCreate`. On success it navigates to `/g/:code`. `GroupCreate.duplicateOf: Signal<{ code: string; name: string } | null>`.

- [ ] **Step 1: Write the failing tests**

`web/src/app/pages/group-create/group-create.spec.ts`:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { GroupCreate } from './group-create';
import { routes } from '../../app.routes';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';

const B = environment.apiBaseUrl;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The caller's own list: one group of theirs, and (as an admin sees it) one of another host's. */
const OWN = [
  { code: 'existing1', name: 'ก๊วน อังคารเดิม' },
  { code: 'other1', name: 'ของคนอื่น', mine: false },
];

describe('GroupCreate', () => {
  let fixture: ComponentFixture<GroupCreate>;
  let component: GroupCreate;
  let httpMock: HttpTestingController;
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GroupCreate],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(routes),
        { provide: AuthService, useValue: { check: () => Promise.resolve(true), role: () => null } },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    fixture = TestBed.createComponent(GroupCreate);
    component = fixture.componentInstance;
    // The constructor reads the host's own groups for the same-name warning.
    httpMock.expectOne({ url: `${B}/groups`, method: 'GET' }).flush(OWN);
    await fixture.whenStable();
  });

  afterEach(() => httpMock.verify());

  const el = () => fixture.nativeElement as HTMLElement;

  it('warns once about a name the host already uses, links to it, and creates on a second submit', async () => {
    component.name.set('  ก๊วน  อังคารเดิม ');
    await component.submit();
    fixture.detectChanges();
    httpMock.expectNone({ url: `${B}/groups`, method: 'POST' });
    const note = el().querySelector('[data-duplicate]')!;
    expect(note.textContent).toContain('คุณมีก๊วนชื่อนี้อยู่แล้ว');
    expect(note.querySelector('a')?.getAttribute('href')).toBe('/g/existing1');

    const done = component.submit();
    const req = httpMock.expectOne({ url: `${B}/groups`, method: 'POST' });
    req.flush({ code: req.request.body.code, name: 'ก๊วน อังคารเดิม' });
    await done;
  });

  it('editing the name clears the same-name note', async () => {
    component.name.set('ก๊วนอังคารเดิม');
    await component.submit();
    component.onNameChange('ก๊วนอังคารใหม่');
    expect(component.duplicateOf()).toBeNull();
  });

  it("never warns about another host's group with the same name", async () => {
    component.name.set('ของคนอื่น');
    const done = component.submit();
    const req = httpMock.expectOne({ url: `${B}/groups`, method: 'POST' });
    req.flush({ code: req.request.body.code, name: 'ของคนอื่น' });
    await done;
    expect(component.duplicateOf()).toBeNull();
  });

  it('offers a way back to the group list before anything is created', () => {
    const back = [...el().querySelectorAll('a')].find((a) => a.getAttribute('href') === '/');
    expect(back).toBeTruthy();
  });

  it('starts with an empty name field and a placeholder example', () => {
    const input = el().querySelector<HTMLInputElement>('#group-name')!;
    expect(input.value).toBe('');
    expect(input.placeholder).toContain('ก๊วนอังคาร');
  });

  it('shows an inline alert and sends nothing for a whitespace-only name', async () => {
    component.name.set('   ');
    await component.submit();
    fixture.detectChanges();
    const alert = el().querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('กรุณาใส่ชื่อก๊วนก่อน');
    httpMock.expectNone(`${B}/groups`);
  });

  it('creates the group with a trimmed name and a full UUID, then opens it', async () => {
    component.name.set('  ก๊วนอังคาร  ');
    const done = component.submit();
    const req = httpMock.expectOne({ url: `${B}/groups`, method: 'POST' });
    expect(req.request.body.name).toBe('ก๊วนอังคาร');
    expect(req.request.body.code).toMatch(UUID);
    req.flush({ code: req.request.body.code, name: 'ก๊วนอังคาร' });
    await done;
    expect(navigate).toHaveBeenCalledWith(`/g/${req.request.body.code}`);
  });

  it('disables the button and says it is creating while the request is in flight', async () => {
    component.name.set('ก๊วนอังคาร');
    const done = component.submit();
    fixture.detectChanges();
    const button = el().querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('กำลังสร้างก๊วน...');
    await component.submit(); // a second tap while busy sends nothing
    const req = httpMock.expectOne(`${B}/groups`);
    req.flush({ code: req.request.body.code, name: 'ก๊วนอังคาร' });
    await done;
  });

  it('keeps the name and reuses the same code when a retry follows a network failure', async () => {
    component.name.set('ก๊วนอังคาร');
    const first = component.submit();
    const failed = httpMock.expectOne(`${B}/groups`);
    const code = failed.request.body.code;
    failed.error(new ProgressEvent('error'), { status: 0, statusText: 'Network' });
    await first;
    fixture.detectChanges();
    expect(component.name()).toBe('ก๊วนอังคาร');
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('สร้างก๊วนไม่สำเร็จ');

    const second = component.submit();
    const retry = httpMock.expectOne(`${B}/groups`);
    expect(retry.request.body.code).toBe(code);
    retry.flush({ code, name: 'ก๊วนอังคาร' });
    await second;
  });

  it('switches to a fresh code after a 404, so it never retries a dead code', async () => {
    component.name.set('ก๊วนอังคาร');
    const first = component.submit();
    const dead = httpMock.expectOne(`${B}/groups`);
    const code = dead.request.body.code;
    dead.flush('Not Found', { status: 404, statusText: 'Not Found' });
    await first;

    const second = component.submit();
    const next = httpMock.expectOne(`${B}/groups`);
    expect(next.request.body.code).not.toBe(code);
    expect(next.request.body.code).toMatch(UUID);
    next.flush({ code: next.request.body.code, name: 'ก๊วนอังคาร' });
    await second;
  });

  it('creates without the check when the group list could not be read', async () => {
    const again = TestBed.createComponent(GroupCreate);
    httpMock.expectOne({ url: `${B}/groups`, method: 'GET' }).flush('x', { status: 500, statusText: 'x' });
    await again.whenStable();
    again.componentInstance.name.set('ก๊วน อังคารเดิม');
    const done = again.componentInstance.submit();
    const req = httpMock.expectOne({ url: `${B}/groups`, method: 'POST' });
    req.flush({ code: req.request.body.code, name: 'ก๊วน อังคารเดิม' });
    await done;
    again.destroy();
  });
});
```

In `web/src/app/pages/landing/landing.spec.ts`, replace the test `'starts a new group and navigates to it'` with:

```ts
  it('sends "create a group" to the name-only creation screen', async () => {
    await loadWith();
    const router = TestBed.inject(Router);
    const spy = vi.spyOn(router, 'navigateByUrl');
    component.startNewGroup();
    expect(spy).toHaveBeenCalledWith('/groups/new');
  });
```

In `web/src/app/app.routes.spec.ts`, import `GroupCreate` from `./pages/group-create/group-create` and add inside `describe('signed in', …)`:

```ts
    it('/groups/new resolves to GroupCreate', async () => {
      const harness = await RouterTestingHarness.create();
      expect(await harness.navigateByUrl('/groups/new', GroupCreate)).toBeInstanceOf(GroupCreate);
    });
```

Then add `['/groups/new', 'group creation'],` to the signed-out `it.each([...])('redirects %s to the login page', …)` table.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd web && npx ng test --watch=false --include=src/app/pages/group-create/group-create.spec.ts --include=src/app/pages/landing/landing.spec.ts --include=src/app/app.routes.spec.ts`
Expected: FAIL. `group-create` cannot be resolved, and landing still navigates to `/g/<8hex>`.

- [ ] **Step 3: Implement the component**

`web/src/app/pages/group-create/group-create.ts`:

```ts
import { HttpErrorResponse } from '@angular/common/http';
import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { RosterService } from '../../core/roster.service';
import { findOwnDuplicate, sameGroupName, type OwnGroupRow } from '../../core/group-name';
import { PressDirective } from '../../core/motion/press.directive';
import { Icon } from '../../shared/icon/icon';

/**
 * Name-only group creation. Saving here is the whole step: no roster, no
 * settings, no session — the group exists and is reachable from the list
 * the moment the server answers, and the host lands on its home.
 */
@Component({
  selector: 'app-group-create',
  imports: [FormsModule, RouterLink, PressDirective, Icon],
  templateUrl: './group-create.html',
  styleUrl: './group-create.css',
})
export class GroupCreate {
  private readonly roster = inject(RosterService);
  private readonly router = inject(Router);
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  readonly name = signal('');
  readonly error = signal<string | null>(null);
  readonly creating = signal(false);

  /**
   * One code per creation attempt, reused across retries so a lost response
   * cannot make a second group. Replaced only after a 404: the server refused
   * this code for this host, so retrying it would fail forever.
   */
  private code = crypto.randomUUID();

  /**
   * The host's own groups, for the same-name note. Empty when the list could
   * not be read: the note is a courtesy, never a gate on creating.
   */
  private readonly ownGroups = signal<OwnGroupRow[]>([]);
  /** The existing group the note is pointing at; a second submit with this name creates anyway. */
  readonly duplicateOf = signal<{ code: string; name: string } | null>(null);

  constructor() {
    this.roster.listGroups().subscribe({ next: (groups) => this.ownGroups.set(groups), error: () => undefined });
  }

  onNameChange(value: string): void {
    this.name.set(value);
    this.error.set(null);
    this.duplicateOf.set(null);
  }

  async submit(): Promise<void> {
    if (this.creating()) return;
    const name = this.name().trim();
    if (!name) {
      this.error.set($localize`:@@entry.errNoGroupName:กรุณาใส่ชื่อก๊วนก่อน`);
      this.nameInput()?.nativeElement.focus();
      return;
    }
    const warned = this.duplicateOf();
    if (!(warned && sameGroupName(warned.name, name))) {
      const clash = findOwnDuplicate(this.ownGroups(), name);
      if (clash) {
        this.duplicateOf.set(clash);
        return;
      }
    }
    this.error.set(null);
    this.creating.set(true);
    try {
      const group = await firstValueFrom(this.roster.createGroup(this.code, name));
      await this.router.navigateByUrl(`/g/${group.code}`);
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 404) this.code = crypto.randomUUID();
      this.error.set($localize`:@@group.createFailed:สร้างก๊วนไม่สำเร็จ กรุณาลองอีกครั้ง`);
    } finally {
      this.creating.set(false);
    }
  }
}
```

`web/src/app/pages/group-create/group-create.html`:

```html
<div class="page group-create">
  <p><a class="back" [routerLink]="['/']" i18n="@@group.backToList">← ก๊วนของฉัน</a></p>
  <h1 class="create-title" i18n="@@group.createTitle">สร้างก๊วนใหม่</h1>
  <p class="muted" i18n="@@group.createLede">ตั้งชื่อก๊วนไว้ก่อน รายชื่อผู้เล่นค่อยเพิ่มตอนเริ่มรอบ</p>

  <form class="create-form" (ngSubmit)="submit()" novalidate>
    <label for="group-name" i18n="@@entry.groupName">ชื่อก๊วน</label>
    <input
      #nameInput
      id="group-name"
      name="groupName"
      type="text"
      autocomplete="off"
      [ngModel]="name()"
      (ngModelChange)="onNameChange($event)"
      [attr.aria-invalid]="error() ? true : null"
      [attr.aria-describedby]="error() ? 'group-name-error' : null"
      i18n-placeholder="@@entry.groupNamePlaceholder"
      placeholder="เช่น ก๊วนอังคาร"
    />
    @if (error()) {
      <p id="group-name-error" class="error" role="alert">{{ error() }}</p>
    }
    @if (duplicateOf(); as dup) {
      <p class="duplicate-note" role="status" data-duplicate>
        <ng-container i18n="@@group.duplicateName">คุณมีก๊วนชื่อนี้อยู่แล้ว</ng-container>
        <a [routerLink]="['/g', dup.code]" i18n="@@group.openExisting">เปิดก๊วนเดิม</a>
        <span class="muted" i18n="@@group.duplicateAgain">กด “สร้างก๊วน” อีกครั้งเพื่อสร้างก๊วนใหม่ชื่อเดียวกัน</span>
      </p>
    }
    <button type="submit" class="create-submit" appPress [disabled]="creating()" [attr.aria-busy]="creating()">
      @if (creating()) {
        <app-icon name="feather" [size]="16" [spin]="true" />
        <ng-container i18n="@@group.creating">กำลังสร้างก๊วน...</ng-container>
      } @else {
        <ng-container i18n="@@group.create">สร้างก๊วน</ng-container>
      }
    </button>
  </form>
</div>
```

`web/src/app/pages/group-create/group-create.css`:

```css
.back {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  text-decoration: none;
  font-size: var(--text-sm);
}

.create-title {
  font-size: var(--text-2xl);
  overflow-wrap: anywhere;
}

.create-form {
  margin-top: var(--space-3);
}

.create-form label {
  margin-bottom: var(--space-0);
}

.duplicate-note {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-0) var(--space-1);
  margin-top: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius);
  background: var(--ground-sunk);
  font-size: var(--text-sm);
}

.duplicate-note a {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
}

.create-submit {
  width: 100%;
  margin-top: var(--space-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
}
```

- [ ] **Step 4: Route and landing**

In `web/src/app/app.routes.ts`, add before the `'g/:groupCode/p/:playerId'` entry:

```ts
  {
    // Name-only group creation. Guarded: creating a group is a host action, and
    // POST /groups is behind AuthGuard on the server to match.
    path: 'groups/new',
    canActivate: [adminGuard],
    loadComponent: () => import('./pages/group-create/group-create').then((m) => m.GroupCreate),
  },
```

In `web/src/app/pages/landing/landing.ts`, replace `startNewGroup`:

```ts
  /** The group is saved by name first; the code is minted on the creation screen. */
  startNewGroup(): void {
    this.router.navigateByUrl('/groups/new');
  }
```

- [ ] **Step 5: Add English translations**

In `web/src/locale/messages.en.xlf`, add one `<trans-unit>` per new id, following the existing shape (`<source>` Thai, `<target>` English):

| id | Thai source | English target |
|---|---|---|
| `group.backToList` | `← ก๊วนของฉัน` | `← My groups` |
| `group.createTitle` | `สร้างก๊วนใหม่` | `New group` |
| `group.createLede` | `ตั้งชื่อก๊วนไว้ก่อน รายชื่อผู้เล่นค่อยเพิ่มตอนเริ่มรอบ` | `Name the group now. Add players when you start a session.` |
| `group.creating` | `กำลังสร้างก๊วน...` | `Creating group…` |
| `group.create` | `สร้างก๊วน` | `Create group` |
| `group.createFailed` | `สร้างก๊วนไม่สำเร็จ กรุณาลองอีกครั้ง` | `Couldn't create the group. Please try again.` |
| `group.duplicateName` | `คุณมีก๊วนชื่อนี้อยู่แล้ว` | `You already have a group with this name.` |
| `group.openExisting` | `เปิดก๊วนเดิม` | `Open it` |
| `group.duplicateAgain` | `กด “สร้างก๊วน” อีกครั้งเพื่อสร้างก๊วนใหม่ชื่อเดียวกัน` | `Tap "Create group" again to make a new one with the same name.` |

Regenerating `messages.xlf` happens once, in Task 8.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `cd web && npx ng test --watch=false --include=src/app/pages/group-create/group-create.spec.ts --include=src/app/pages/landing/landing.spec.ts --include=src/app/app.routes.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/app/pages/group-create web/src/app/app.routes.ts web/src/app/app.routes.spec.ts web/src/app/pages/landing/landing.ts web/src/app/pages/landing/landing.spec.ts web/src/locale/messages.en.xlf
git commit -m "feat(web): name-only create-group screen at /groups/new"
```

---

### Task 4: Settings detail screen at `/g/:groupCode/settings/:section`

This task moves share, advanced and manage out of `GroupEntry` into their own screen. `GroupEntry` keeps its copies until Task 6 removes them, so nothing disappears between tasks.

**Files:**
- Create: `web/src/app/pages/group-settings-detail/group-settings-detail.ts`
- Create: `web/src/app/pages/group-settings-detail/group-settings-detail.html`
- Create: `web/src/app/pages/group-settings-detail/group-settings-detail.css`
- Create: `web/src/app/pages/group-settings-detail/group-settings-detail.spec.ts`
- Modify: `web/src/app/shared/share-dashboard-panel/share-dashboard-panel.html` (replace the obsolete `share.unavailable` message)
- Modify: `web/src/app/shared/share-dashboard-panel/share-dashboard-panel.spec.ts` if it asserts that text
- Modify: `web/src/app/app.routes.ts`, `web/src/app/app.routes.spec.ts`

**Interfaces:**
- Consumes: `RosterService.getGroup`, `listGroups`, `renameGroup`, `exportGroup`, `deleteGroup`, `getShuttleTools`, `setShuttleTools`, `getCrossSessionHistory`, `setCrossSessionHistory`. Also `ShareDashboardPanel`, and `isDetailSection`/`settingsReturn`/`findOwnDuplicate`/`sameGroupName` from Task 2.
- Produces: route `g/:groupCode/settings/:section` → `GroupSettingsDetail`. Its back link is `/g/:code?settings=<section>`.

- [ ] **Step 1: Write the failing tests**

`web/src/app/pages/group-settings-detail/group-settings-detail.spec.ts`:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { GroupSettingsDetail } from './group-settings-detail';
import { routes } from '../../app.routes';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';

const B = environment.apiBaseUrl;
const GROUP = { code: 'group1', name: 'ก๊วนอังคาร', lastSessionCode: null };

describe('GroupSettingsDetail', () => {
  let httpMock: HttpTestingController;
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(routes),
        { provide: AuthService, useValue: { check: () => Promise.resolve(true), role: () => null } },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => httpMock.verify());

  async function open(section: string) {
    const page = await harness.navigateByUrl(`/g/group1/settings/${section}`, GroupSettingsDetail);
    httpMock.expectOne(`${B}/groups/group1`).flush(GROUP);
    await harness.fixture.whenStable();
    // Manage reads the host's own groups for the same-name note on rename.
    if (section === 'manage') {
      httpMock.expectOne({ url: `${B}/groups`, method: 'GET' }).flush([
        { code: 'group1', name: 'ก๊วนอังคาร' },
        { code: 'group2', name: 'ก๊วนพุธ' },
      ]);
      await harness.fixture.whenStable();
    }
    return page;
  }
  const el = () => harness.routeNativeElement as HTMLElement;

  it('names the group in its back link, which returns to the open settings row', async () => {
    await open('manage');
    const back = el().querySelector<HTMLAnchorElement>('a.back')!;
    expect(back.textContent).toContain('ก๊วนอังคาร');
    expect(back.getAttribute('href')).toBe('/g/group1?settings=manage');
  });

  describe('share', () => {
    it('states who can see the summary and shows the existing share panel', async () => {
      await open('share');
      httpMock.expectOne(`${B}/groups/group1/share`).flush({ token: null });
      await harness.fixture.whenStable();
      expect(el().textContent).toContain('ทุกคนที่มีลิงก์สามารถดูหน้าสรุปก๊วนได้');
      expect(el().querySelector('app-share-dashboard-panel')).toBeTruthy();
      expect(el().querySelector('[data-share]')).toBeTruthy(); // explicit create, never automatic
    });
  });

  describe('advanced', () => {
    async function openAdvanced(shuttle: boolean, history: boolean) {
      await open('advanced');
      httpMock.expectOne(`${B}/groups/group1/shuttle-tools`).flush({ enabled: shuttle });
      httpMock.expectOne(`${B}/groups/group1/cross-session-history`).flush({ enabled: history });
      await harness.fixture.whenStable();
    }
    const box = (name: string) => el().querySelector<HTMLInputElement>(`input[name="${name}"]`)!;

    it('loads both switches before any roster exists', async () => {
      await openAdvanced(false, true);
      expect(box('shuttleTools').checked).toBe(false);
      expect(box('crossSessionHistory').checked).toBe(true);
    });

    it('keeps the on/off explanation for cross-session history', async () => {
      await openAdvanced(false, false);
      expect(el().textContent).toContain('ปิด: เลี่ยงคู่ซ้ำเฉพาะคืนนี้ · เปิด: นับทุกรอบที่ผ่านมา');
      expect(el().textContent).toContain('มีผลกับรอบที่สร้างต่อจากนี้');
    });

    it('saves a switch and shows the saved value', async () => {
      await openAdvanced(false, false);
      box('shuttleTools').checked = true;
      box('shuttleTools').dispatchEvent(new Event('change'));
      const req = httpMock.expectOne({ url: `${B}/groups/group1/shuttle-tools`, method: 'POST' });
      expect(req.request.body).toEqual({ enabled: true });
      req.flush({ enabled: true });
      await harness.fixture.whenStable();
      expect(box('shuttleTools').checked).toBe(true);
    });

    it('puts the switch back and says so when saving fails', async () => {
      await openAdvanced(false, false);
      box('crossSessionHistory').checked = true;
      box('crossSessionHistory').dispatchEvent(new Event('change'));
      httpMock
        .expectOne({ url: `${B}/groups/group1/cross-session-history`, method: 'POST' })
        .flush('x', { status: 500, statusText: 'x' });
      await harness.fixture.whenStable();
      expect(box('crossSessionHistory').checked).toBe(false);
      expect(el().querySelector('[role="alert"]')?.textContent).toContain('บันทึกไม่สำเร็จ');
    });

    it('says the settings could not be loaded instead of showing defaults', async () => {
      await open('advanced');
      httpMock.expectOne(`${B}/groups/group1/shuttle-tools`).flush('x', { status: 500, statusText: 'x' });
      httpMock.expectOne(`${B}/groups/group1/cross-session-history`).flush({ enabled: false });
      await harness.fixture.whenStable();
      expect(el().querySelector('[role="alert"]')?.textContent).toContain('โหลดการตั้งค่าไม่สำเร็จ');
      expect(box('shuttleTools').disabled).toBe(true);
    });
  });

  describe('manage', () => {
    it('renames the group with a trimmed name', async () => {
      const page = await open('manage');
      page.renameDraft.set('  ก๊วนพุธ  ');
      const done = page.rename();
      const req = httpMock.expectOne({ url: `${B}/groups/group1`, method: 'PUT' });
      expect(req.request.body).toEqual({ name: 'ก๊วนพุธ' });
      req.flush({ code: 'group1', name: 'ก๊วนพุธ' });
      await done;
      await harness.fixture.whenStable();
      expect(el().querySelector('a.back')?.textContent).toContain('ก๊วนพุธ');
    });

    it("warns once when renaming to another of the host's group names, then renames on a second save", async () => {
      const page = await open('manage');
      page.renameDraft.set('ก๊วนพุธ');
      await page.rename();
      await harness.fixture.whenStable();
      httpMock.expectNone({ url: `${B}/groups/group1`, method: 'PUT' });
      expect(el().querySelector('[data-duplicate]')?.textContent).toContain('คุณมีก๊วนชื่อนี้อยู่แล้ว');

      const done = page.rename();
      httpMock.expectOne({ url: `${B}/groups/group1`, method: 'PUT' }).flush({ code: 'group1', name: 'ก๊วนพุธ' });
      await done;
    });

    it('does not warn when saving the group under its own current name', async () => {
      const page = await open('manage');
      page.renameDraft.set('ก๊วนอังคาร');
      const done = page.rename();
      httpMock.expectOne({ url: `${B}/groups/group1`, method: 'PUT' }).flush({ code: 'group1', name: 'ก๊วนอังคาร' });
      await done;
    });

    it('refuses a blank rename inline without a request', async () => {
      const page = await open('manage');
      page.renameDraft.set('   ');
      await page.rename();
      await harness.fixture.whenStable();
      expect(el().querySelector('[role="alert"]')?.textContent).toContain('กรุณาใส่ชื่อก๊วนก่อน');
    });

    it('enables delete only once the group name is typed back, and deletion sits inside the danger zone', async () => {
      const page = await open('manage');
      const del = () => el().querySelector<HTMLButtonElement>('.danger-zone button.danger')!;
      expect(del().disabled).toBe(true);
      page.deleteConfirmText.set('ก๊วนอังคาร');
      await harness.fixture.whenStable();
      expect(del().disabled).toBe(false);
    });

    it('deletes and returns to the group list', async () => {
      const page = await open('manage');
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
      page.deleteConfirmText.set('ก๊วนอังคาร');
      const done = page.deleteGroup();
      httpMock.expectOne({ url: `${B}/groups/group1`, method: 'DELETE' }).flush({ code: 'group1', deleted: true });
      await done;
      expect(navigate).toHaveBeenCalledWith('/');
    });
  });

  it('shows not-found for an unknown section', async () => {
    await harness.navigateByUrl('/g/group1/settings/nope', GroupSettingsDetail);
    httpMock.expectOne(`${B}/groups/group1`).flush(GROUP);
    await harness.fixture.whenStable();
    expect(el().textContent).toContain('ไม่พบหน้านี้');
  });

  it('shows not-found when the group does not exist', async () => {
    await harness.navigateByUrl('/g/group1/settings/manage', GroupSettingsDetail);
    httpMock.expectOne(`${B}/groups/group1`).flush('x', { status: 404, statusText: 'Not Found' });
    await harness.fixture.whenStable();
    expect(el().textContent).toContain('ไม่พบก๊วนนี้');
    expect(el().querySelector('.danger-zone')).toBeNull();
  });
});
```

In `web/src/app/app.routes.spec.ts`, import `GroupSettingsDetail` and add to `describe('signed in', …)`:

```ts
    it('/g/:groupCode/settings/:section resolves to GroupSettingsDetail', async () => {
      const harness = await RouterTestingHarness.create();
      expect(await harness.navigateByUrl('/g/abc123/settings/share', GroupSettingsDetail)).toBeInstanceOf(
        GroupSettingsDetail
      );
    });
```

Then add `['/g/abc123/settings/manage', 'group settings'],` to the signed-out redirect table.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd web && npx ng test --watch=false --include=src/app/pages/group-settings-detail/group-settings-detail.spec.ts --include=src/app/app.routes.spec.ts`
Expected: FAIL, because the module cannot be resolved.

- [ ] **Step 3: Implement**

`web/src/app/pages/group-settings-detail/group-settings-detail.ts`:

```ts
import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { RosterService } from '../../core/roster.service';
import { findOwnDuplicate, sameGroupName, type OwnGroupRow } from '../../core/group-name';
import { isDetailSection, settingsReturn, type DetailSection } from '../../core/settings-sections';
import { ShareDashboardPanel } from '../../shared/share-dashboard-panel/share-dashboard-panel';

/**
 * One group setting at a time: sharing, advanced switches, or managing the
 * group itself (rename, export, delete). Moved off the old group-entry page so
 * every setting is reachable before a session exists. The back link names the
 * group and returns to its settings row, so a host with several groups never
 * loses which one they are editing.
 */
@Component({
  selector: 'app-group-settings-detail',
  imports: [FormsModule, RouterLink, ShareDashboardPanel],
  templateUrl: './group-settings-detail.html',
  styleUrl: './group-settings-detail.css',
})
export class GroupSettingsDetail {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly roster = inject(RosterService);

  protected readonly groupCode = this.route.snapshot.paramMap.get('groupCode')!;
  private readonly rawSection = this.route.snapshot.paramMap.get('section');
  protected readonly section: DetailSection | null = isDetailSection(this.rawSection) ? this.rawSection : null;

  readonly status = signal<'loading' | 'ready' | 'not-found' | 'error'>('loading');
  readonly groupName = signal('');
  protected readonly back = computed(() => settingsReturn(this.groupCode, this.section ?? 'manage'));

  // advanced
  readonly shuttleTools = signal<boolean | null>(null);
  readonly crossSessionHistory = signal<boolean | null>(null);
  readonly advancedLoadFailed = signal(false);
  readonly advancedSaving = signal(false);
  readonly advancedError = signal<string | null>(null);
  readonly advancedSaved = signal(false);

  // manage
  readonly renameDraft = signal('');
  readonly renaming = signal(false);
  readonly renameError = signal<string | null>(null);
  readonly renameSaved = signal(false);
  /** Same-name courtesy note on rename; a second save with this name goes ahead. */
  readonly renameDuplicateOf = signal<{ code: string; name: string } | null>(null);
  private readonly ownGroups = signal<OwnGroupRow[]>([]);
  readonly deleteConfirmText = signal('');
  readonly dangerError = signal<string | null>(null);
  readonly canDelete = computed(
    () => this.groupName().trim().length > 0 && this.deleteConfirmText().trim() === this.groupName().trim()
  );

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.status.set('loading');
    try {
      const group = await firstValueFrom(this.roster.getGroup(this.groupCode));
      this.groupName.set(group.name ?? '');
      this.renameDraft.set(group.name ?? '');
      this.status.set('ready');
      if (this.section === 'advanced') this.loadAdvanced();
      if (this.section === 'manage') {
        this.roster.listGroups().subscribe({ next: (g) => this.ownGroups.set(g), error: () => undefined });
      }
    } catch (err) {
      this.status.set(err instanceof HttpErrorResponse && err.status === 404 ? 'not-found' : 'error');
    }
  }

  private loadAdvanced(): void {
    this.roster.getShuttleTools(this.groupCode).subscribe({
      next: (r) => this.shuttleTools.set(r.enabled),
      error: () => this.advancedLoadFailed.set(true),
    });
    this.roster.getCrossSessionHistory(this.groupCode).subscribe({
      next: (r) => this.crossSessionHistory.set(r.enabled),
      error: () => this.advancedLoadFailed.set(true),
    });
  }

  /**
   * Saves one switch. The box never shows an unsaved value: it snaps back to
   * the saved state at once (while disabled for the write) and only moves when
   * the server confirms, so a failed save cannot leave it lying.
   */
  setAdvanced(which: 'shuttleTools' | 'crossSessionHistory', input: HTMLInputElement): void {
    const target = which === 'shuttleTools' ? this.shuttleTools : this.crossSessionHistory;
    const enabled = input.checked;
    input.checked = target() === true;
    this.advancedError.set(null);
    this.advancedSaved.set(false);
    this.advancedSaving.set(true);
    const save =
      which === 'shuttleTools'
        ? this.roster.setShuttleTools(this.groupCode, enabled)
        : this.roster.setCrossSessionHistory(this.groupCode, enabled);
    save.subscribe({
      next: (r) => {
        target.set(r.enabled);
        input.checked = r.enabled;
        this.advancedSaving.set(false);
        this.advancedSaved.set(true);
      },
      error: () => {
        this.advancedError.set($localize`:@@entry.advancedSaveFailed:บันทึกไม่สำเร็จ ลองอีกครั้ง`);
        this.advancedSaving.set(false);
      },
    });
  }

  async rename(): Promise<void> {
    if (this.renaming()) return;
    const name = this.renameDraft().trim();
    this.renameSaved.set(false);
    if (!name) {
      this.renameError.set($localize`:@@entry.errNoGroupName:กรุณาใส่ชื่อก๊วนก่อน`);
      return;
    }
    const warned = this.renameDuplicateOf();
    if (!(warned && sameGroupName(warned.name, name))) {
      const clash = findOwnDuplicate(this.ownGroups(), name, this.groupCode);
      if (clash) {
        this.renameDuplicateOf.set(clash);
        return;
      }
    }
    this.renameDuplicateOf.set(null);
    this.renameError.set(null);
    this.renaming.set(true);
    try {
      const saved = await firstValueFrom(this.roster.renameGroup(this.groupCode, name));
      this.groupName.set(saved.name ?? name);
      this.renameDraft.set(saved.name ?? name);
      this.renameSaved.set(true);
    } catch {
      this.renameError.set($localize`:@@entry.renameFailed:บันทึกชื่อก๊วนไม่สำเร็จ`);
    } finally {
      this.renaming.set(false);
    }
  }

  async exportGroup(): Promise<void> {
    this.dangerError.set(null);
    try {
      const data = await firstValueFrom(this.roster.exportGroup(this.groupCode));
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `jubbad-${this.groupCode}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      this.dangerError.set($localize`:@@entry.exportFailed:ดาวน์โหลดไม่สำเร็จ`);
    }
  }

  async deleteGroup(): Promise<void> {
    if (!this.canDelete()) return;
    this.dangerError.set(null);
    try {
      await firstValueFrom(this.roster.deleteGroup(this.groupCode));
      await this.router.navigateByUrl('/');
    } catch {
      this.dangerError.set($localize`:@@entry.deleteFailed:ลบก๊วนไม่สำเร็จ`);
    }
  }
}
```

`web/src/app/pages/group-settings-detail/group-settings-detail.html`:

```html
<div class="page group-settings-detail">
  <p>
    <a class="back" [routerLink]="back().commands" [queryParams]="back().queryParams">← {{ groupName() || groupCode }}</a>
  </p>

  @switch (status()) {
    @case ('loading') {
      <p class="muted" role="status" i18n="@@group.loading">กำลังโหลดก๊วน...</p>
    }
    @case ('not-found') {
      <h1 class="detail-title" i18n="@@group.notFound">ไม่พบก๊วนนี้</h1>
      <p class="muted" i18n="@@group.notFoundHint">ลิงก์อาจพิมพ์ผิด หรือก๊วนถูกลบไปแล้ว</p>
    }
    @case ('error') {
      <p class="error" role="alert">
        <ng-container i18n="@@group.loadFailed">โหลดก๊วนไม่สำเร็จ</ng-container>
        <button type="button" class="ghost" (click)="load()" i18n="@@entry.retry">ลองอีกครั้ง</button>
      </p>
    }
    @case ('ready') {
      @switch (section) {
        @case ('share') {
          <h1 class="detail-title" i18n="@@group.row.share">แชร์หน้าสรุปก๊วน</h1>
          <p class="audience">
            <strong i18n="@@group.shareAudience">ทุกคนที่มีลิงก์สามารถดูหน้าสรุปก๊วนได้</strong><br />
            <span class="muted" i18n="@@group.shareShows">แสดงเฉพาะจำนวนเกมที่เล่น ไม่มีเรตติ้งหรือข้อมูลติดต่อ</span>
          </p>
          <app-share-dashboard-panel [groupCode]="groupCode" />
        }
        @case ('advanced') {
          <h1 class="detail-title" i18n="@@group.row.advanced">ตั้งค่าขั้นสูง</h1>
          <p class="muted" i18n="@@group.advancedHint">มีผลกับรอบที่สร้างต่อจากนี้ รอบที่เปิดอยู่แล้วไม่เปลี่ยน</p>
          @if (advancedLoadFailed()) {
            <p class="error" role="alert" i18n="@@group.advancedLoadFailed">โหลดการตั้งค่าไม่สำเร็จ</p>
          }
          <div class="advanced-settings">
            <label class="switch-row">
              <input
                type="checkbox"
                name="shuttleTools"
                [checked]="shuttleTools() === true"
                [disabled]="shuttleTools() === null || advancedSaving()"
                (change)="setAdvanced('shuttleTools', $any($event.target))"
              />
              <span class="switch-text">
                <span class="switch-title" i18n="@@entry.shuttleTools">จดลูกแบดเป็นหมายเลข</span>
                <span class="muted" i18n="@@entry.shuttleToolsHint">ตอนยืนยันแมตช์จะให้เลือกลูกแบด และบิลจะนับตามลูกที่ใช้จริง</span>
              </span>
            </label>
            <label class="switch-row">
              <input
                type="checkbox"
                name="crossSessionHistory"
                [checked]="crossSessionHistory() === true"
                [disabled]="crossSessionHistory() === null || advancedSaving()"
                (change)="setAdvanced('crossSessionHistory', $any($event.target))"
              />
              <span class="switch-text">
                <span class="switch-title" i18n="@@group.crossSessionHistory">นับประวัติคู่ข้ามรอบ</span>
                <span class="muted" i18n="@@group.crossSessionHistoryHint">ปิด: เลี่ยงคู่ซ้ำเฉพาะคืนนี้ · เปิด: นับทุกรอบที่ผ่านมา</span>
              </span>
            </label>
          </div>
          @if (advancedError()) {
            <p class="error" role="alert">{{ advancedError() }}</p>
          }
          @if (advancedSaved()) {
            <p class="saved" role="status" i18n="@@group.saved">บันทึกแล้ว</p>
          }
        }
        @case ('manage') {
          <h1 class="detail-title" i18n="@@group.row.manage">จัดการก๊วน</h1>
          <form class="rename" (ngSubmit)="rename()" novalidate>
            <label for="rename-input" i18n="@@entry.groupName">ชื่อก๊วน</label>
            <div class="rename-row">
              <input id="rename-input" name="rename" type="text" autocomplete="off" [ngModel]="renameDraft()" (ngModelChange)="renameDraft.set($event); renameDuplicateOf.set(null)" [disabled]="renaming()" />
              <button type="submit" class="ghost" [disabled]="renaming()" i18n="@@group.saveName">บันทึกชื่อ</button>
            </div>
            @if (renameError()) {
              <p class="error" role="alert">{{ renameError() }}</p>
            }
            @if (renameDuplicateOf(); as dup) {
              <p class="duplicate-note" role="status" data-duplicate>
                <ng-container i18n="@@group.duplicateName">คุณมีก๊วนชื่อนี้อยู่แล้ว</ng-container>
                <a [routerLink]="['/g', dup.code]" i18n="@@group.openExisting">เปิดก๊วนเดิม</a>
                <span class="muted" i18n="@@group.duplicateRenameAgain">กด “บันทึกชื่อ” อีกครั้งเพื่อใช้ชื่อนี้</span>
              </p>
            }
            @if (renameSaved()) {
              <p class="saved" role="status" i18n="@@group.nameSaved">บันทึกชื่อก๊วนแล้ว</p>
            }
          </form>

          <section class="detail-section">
            <h2 i18n="@@group.exportTitle">ดาวน์โหลดข้อมูล</h2>
            <p class="muted" i18n="@@group.exportHint">ผู้เล่น รอบ และผลแมตช์ทั้งหมดของก๊วน เป็นไฟล์ JSON</p>
            <button type="button" class="ghost" (click)="exportGroup()" i18n="@@entry.export">ดาวน์โหลดข้อมูล (JSON)</button>
          </section>

          <section class="detail-section">
            <h2 i18n="@@group.deleteTitle">ลบก๊วน</h2>
            <div class="danger-zone">
              <p i18n="@@group.deleteWarning">ลบก๊วนนี้ถาวร รวมผู้เล่นและประวัติทุกรอบ กู้คืนไม่ได้</p>
              <label for="delete-confirm" i18n="@@entry.typeNameToDelete">พิมพ์ชื่อก๊วนเพื่อยืนยัน</label>
              <input id="delete-confirm" name="deleteConfirm" type="text" autocomplete="off" [ngModel]="deleteConfirmText()" (ngModelChange)="deleteConfirmText.set($event)" />
              <button type="button" class="danger" [disabled]="!canDelete()" (click)="deleteGroup()" i18n="@@entry.deleteGroup">ลบก๊วนนี้</button>
            </div>
          </section>
          @if (dangerError()) {
            <p class="error" role="alert">{{ dangerError() }}</p>
          }
        }
        @default {
          <h1 class="detail-title" i18n="@@group.sectionNotFound">ไม่พบหน้านี้</h1>
        }
      }
    }
  }
</div>
```

`web/src/app/pages/group-settings-detail/group-settings-detail.css`:

```css
.back {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  text-decoration: none;
  font-size: var(--text-sm);
}

.detail-title {
  font-size: var(--text-2xl);
  overflow-wrap: anywhere;
}

.detail-section {
  margin-top: var(--space-4);
}

.detail-section h2 {
  font-size: var(--text-xl);
}

.audience {
  margin: var(--space-2) 0 var(--space-3);
}

.advanced-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.switch-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-height: var(--tap);
  cursor: pointer;
  color: var(--ink);
  font-size: var(--text-base);
  font-weight: 400;
  margin: 0;
}

.switch-row input {
  width: 1.5rem;
  min-height: 1.5rem;
  flex: none;
  margin-top: var(--space-0);
  accent-color: var(--court);
}

.switch-text {
  display: flex;
  flex-direction: column;
}

.switch-title {
  font-weight: 600;
}

.rename {
  margin-top: var(--space-3);
}

.rename-row {
  display: flex;
  gap: var(--space-1);
}

.rename-row input {
  flex: 1;
  min-width: 0;
}

.danger-zone {
  padding: var(--space-2);
  border: 1.5px dashed var(--warn);
  border-radius: var(--radius);
}

.danger-zone button.danger {
  width: 100%;
  margin-top: var(--space-2);
}

.duplicate-note {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-0) var(--space-1);
  margin-top: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius);
  background: var(--ground-sunk);
  font-size: var(--text-sm);
}

.duplicate-note a {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
}

.saved {
  margin-top: var(--space-1);
  color: var(--court-ink);
  font-size: var(--text-sm);
  font-weight: 600;
}
```

In `web/src/app/shared/share-dashboard-panel/share-dashboard-panel.html`, replace:

```html
    <p class="muted" data-unavailable i18n="@@share.unavailable">ใช้ได้หลังสร้างก๊วนครั้งแรก</p>
```

with:

```html
    <p class="error" role="alert" data-unavailable i18n="@@share.loadFailed">โหลดสถานะการแชร์ไม่สำเร็จ</p>
```

The group always exists now, so "available after the group is first created" can no longer occur. A failed load is the only remaining cause. If `share-dashboard-panel.spec.ts` asserts the old text, update it to the new text.

Route: in `web/src/app/app.routes.ts`, add before `'g/:groupCode'`:

```ts
  {
    // Before 'g/:groupCode'. Guarded: share, advanced and manage are host-only,
    // and every server route they call is owner-only.
    path: 'g/:groupCode/settings/:section',
    canActivate: [adminGuard],
    loadComponent: () =>
      import('./pages/group-settings-detail/group-settings-detail').then((m) => m.GroupSettingsDetail),
  },
```

English targets to add to `messages.en.xlf`:

| id | Thai | English |
|---|---|---|
| `group.loading` | `กำลังโหลดก๊วน...` | `Loading group…` |
| `group.notFound` | `ไม่พบก๊วนนี้` | `Group not found` |
| `group.notFoundHint` | `ลิงก์อาจพิมพ์ผิด หรือก๊วนถูกลบไปแล้ว` | `The link may be mistyped, or the group was deleted.` |
| `group.loadFailed` | `โหลดก๊วนไม่สำเร็จ` | `Couldn't load the group.` |
| `group.row.share` | `แชร์หน้าสรุปก๊วน` | `Share group summary` |
| `group.shareAudience` | `ทุกคนที่มีลิงก์สามารถดูหน้าสรุปก๊วนได้` | `Anyone with the link can see the group summary.` |
| `group.shareShows` | `แสดงเฉพาะจำนวนเกมที่เล่น ไม่มีเรตติ้งหรือข้อมูลติดต่อ` | `It shows games played only — no ratings or contact details.` |
| `group.row.advanced` | `ตั้งค่าขั้นสูง` | `Advanced settings` |
| `group.advancedHint` | `มีผลกับรอบที่สร้างต่อจากนี้ รอบที่เปิดอยู่แล้วไม่เปลี่ยน` | `Applies to sessions created from now on. Open sessions don't change.` |
| `group.advancedLoadFailed` | `โหลดการตั้งค่าไม่สำเร็จ` | `Couldn't load these settings.` |
| `group.crossSessionHistory` | `นับประวัติคู่ข้ามรอบ` | `Count partner history across sessions` |
| `group.crossSessionHistoryHint` | `ปิด: เลี่ยงคู่ซ้ำเฉพาะคืนนี้ · เปิด: นับทุกรอบที่ผ่านมา` | `Off: avoid repeats tonight only · On: count every past session` |
| `group.saved` | `บันทึกแล้ว` | `Saved` |
| `group.row.manage` | `จัดการก๊วน` | `Manage group` |
| `group.saveName` | `บันทึกชื่อ` | `Save name` |
| `group.nameSaved` | `บันทึกชื่อก๊วนแล้ว` | `Group name saved` |
| `group.duplicateRenameAgain` | `กด “บันทึกชื่อ” อีกครั้งเพื่อใช้ชื่อนี้` | `Tap "Save name" again to use it anyway.` |
| `group.exportTitle` | `ดาวน์โหลดข้อมูล` | `Download data` |
| `group.exportHint` | `ผู้เล่น รอบ และผลแมตช์ทั้งหมดของก๊วน เป็นไฟล์ JSON` | `Every player, session and match in this group, as a JSON file.` |
| `group.deleteTitle` | `ลบก๊วน` | `Delete group` |
| `group.deleteWarning` | `ลบก๊วนนี้ถาวร รวมผู้เล่นและประวัติทุกรอบ กู้คืนไม่ได้` | `Permanently deletes this group, its players and every session's history. This can't be undone.` |
| `group.sectionNotFound` | `ไม่พบหน้านี้` | `Page not found` |
| `share.loadFailed` | `โหลดสถานะการแชร์ไม่สำเร็จ` | `Couldn't load the sharing status.` |

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd web && npx ng test --watch=false --include=src/app/pages/group-settings-detail/group-settings-detail.spec.ts --include=src/app/shared/share-dashboard-panel/share-dashboard-panel.spec.ts --include=src/app/app.routes.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/pages/group-settings-detail web/src/app/shared/share-dashboard-panel web/src/app/app.routes.ts web/src/app/app.routes.spec.ts web/src/locale/messages.en.xlf
git commit -m "feat(web): group settings detail screen for share, advanced and manage"
```

---

### Task 5: Group home at `/g/:groupCode`; roster entry moves to `/start`

**Files:**
- Create: `web/src/app/pages/group-home/group-home.ts`
- Create: `web/src/app/pages/group-home/group-home.html`
- Create: `web/src/app/pages/group-home/group-home.css`
- Create: `web/src/app/pages/group-home/group-home.spec.ts`
- Modify: `web/src/app/app.routes.ts` (`g/:groupCode` → `GroupHome`; add `g/:groupCode/start` → `GroupEntry`)
- Modify: `web/src/app/app.routes.spec.ts`

**Interfaces:**
- Consumes: `RosterService.getGroup`, `listSessions`, `getPlayers`, `getGroupLevels`, `getShare`, `getShuttleTools`, `getCrossSessionHistory`. Also `isSettingsSection` and `SettingsSection` from Task 2, and the `gear` icon.
- Produces: `GroupHome`, which reads the query parameter `settings=<section>`. Routes: `g/:groupCode` → `GroupHome`, `g/:groupCode/start` → `GroupEntry`.

- [ ] **Step 1: Write the failing tests**

`web/src/app/pages/group-home/group-home.spec.ts`:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { GroupHome } from './group-home';
import { routes } from '../../app.routes';
import { AuthService } from '../../core/auth.service';
import { environment } from '../../../environments/environment';
import type { GroupSession } from '../../core/group-session.model';

const B = environment.apiBaseUrl;
const tick = () => new Promise<void>((r) => setTimeout(r));
const SESSION: GroupSession = {
  code: 's1',
  date: '2026-10-11',
  venue: null,
  courtCount: 2,
  createdAt: '2026-10-11T12:00:00.000Z',
  endedAt: null,
  matchCount: 22,
};

describe('GroupHome', () => {
  let httpMock: HttpTestingController;
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(routes),
        { provide: AuthService, useValue: { check: () => Promise.resolve(true), role: () => null } },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => httpMock.verify());

  const el = () => harness.routeNativeElement as HTMLElement;
  const trigger = () => el().querySelector<HTMLButtonElement>('[data-settings-trigger]')!;
  const list = () => el().querySelector<HTMLElement>('#group-settings')!;

  async function open(url = '/g/group1', opts: { lastSessionCode?: string | null; sessions?: GroupSession[] } = {}) {
    const page = await harness.navigateByUrl(url, GroupHome);
    httpMock
      .expectOne(`${B}/groups/group1`)
      .flush({ code: 'group1', name: 'ก๊วนอังคาร', lastSessionCode: opts.lastSessionCode ?? null });
    httpMock.expectOne(`${B}/groups/group1/sessions`).flush(opts.sessions ?? []);
    await harness.fixture.whenStable();
    return page;
  }

  function flushValues(over: { players?: number; custom?: boolean; shared?: boolean; shuttle?: boolean; history?: boolean } = {}) {
    httpMock.expectOne(`${B}/groups/group1/players`).flush(
      Array.from({ length: over.players ?? 0 }, (_, i) => ({ id: `p${i}`, name: `p${i}`, aliases: [] }))
    );
    httpMock.expectOne(`${B}/groups/group1/levels`).flush({
      mode: over.custom ? 'custom' : 'standard',
      revision: 1,
      levels: over.custom
        ? [1, 2, 3, 4, 5].map((n) => ({ id: `l${n}`, name: `L${n}`, startingElo: 1000 + n }))
        : [],
      assignedCounts: {},
    });
    httpMock.expectOne(`${B}/groups/group1/share`).flush({ token: over.shared ? 'tok' : null });
    httpMock.expectOne(`${B}/groups/group1/shuttle-tools`).flush({ enabled: over.shuttle ?? false });
    httpMock.expectOne(`${B}/groups/group1/cross-session-history`).flush({ enabled: over.history ?? false });
  }

  it('shows the saved name with a labelled settings button beside it, closed, and makes no settings request yet', async () => {
    await open();
    expect(el().querySelector('h1')?.textContent).toContain('ก๊วนอังคาร');
    expect(trigger().textContent).toContain('ตั้งค่าก๊วน');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-controls')).toBe('group-settings');
    expect(list().hidden).toBe(true);
  });

  it('a group without sessions shows the save-confirming hint and เริ่มรอบแรก, with no resume link', async () => {
    await open();
    expect(el().querySelector('[data-hint]')?.textContent).toContain('บันทึกก๊วนแล้ว');
    expect(el().querySelector('[data-start]')?.textContent).toContain('เริ่มรอบแรก');
    expect(el().querySelector('[data-resume]')).toBeNull();
  });

  it('a group with sessions shows the header resume link above settings, เริ่มรอบใหม่ and past sessions, and no hint', async () => {
    await open('/g/group1', { lastSessionCode: 's1', sessions: [SESSION] });
    const resume = el().querySelector<HTMLAnchorElement>('[data-resume]')!;
    expect(resume.getAttribute('href')).toBe('/s/s1');
    expect(resume.compareDocumentPosition(list()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(el().querySelector('[data-hint]')).toBeNull();
    expect(el().querySelector('[data-start]')?.textContent).toContain('เริ่มรอบใหม่');
    expect(el().textContent).toContain('รอบที่ผ่านมา');
  });

  it('the start action goes to the roster screen', async () => {
    await open();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    el().querySelector<HTMLButtonElement>('[data-start]')!.click();
    expect(nav.mock.calls[0][0].toString()).toBe('/g/group1/start');
  });

  it('opening settings reveals five rows in order, with management last', async () => {
    await open();
    trigger().click();
    await harness.fixture.whenStable();
    flushValues();
    await harness.fixture.whenStable();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(list().hidden).toBe(false);
    const rows = [...list().querySelectorAll<HTMLAnchorElement>('a[data-section]')];
    expect(rows.map((r) => r.dataset['section'])).toEqual(['players', 'levels', 'share', 'advanced', 'manage']);
    expect(rows.map((r) => r.getAttribute('href'))).toEqual([
      '/g/group1/players',
      '/g/group1/levels',
      '/g/group1/settings/share',
      '/g/group1/settings/advanced',
      '/g/group1/settings/manage',
    ]);
    expect(rows[4].textContent).toContain('ชื่อก๊วน / ดาวน์โหลดข้อมูล / ลบก๊วน');
  });

  it('rows show live values once loaded', async () => {
    await open();
    trigger().click();
    await harness.fixture.whenStable();
    flushValues({ players: 14, custom: true, shared: true, shuttle: true });
    await harness.fixture.whenStable();
    const value = (s: string) => list().querySelector(`[data-section="${s}"] .value`)?.textContent?.trim();
    expect(value('players')).toBe('14 คน');
    expect(value('levels')).toBe('กำหนดเอง · 5 ระดับ');
    expect(value('share')).toBe('แชร์อยู่');
    expect(value('advanced')).toBe('เปิด 1 จาก 2');
    expect(list().querySelector('[data-section="manage"] .value')).toBeNull();
  });

  it('a failed value fetch leaves only the description — never a guessed value', async () => {
    await open();
    trigger().click();
    await harness.fixture.whenStable();
    httpMock.expectOne(`${B}/groups/group1/players`).flush('x', { status: 500, statusText: 'x' });
    httpMock.expectOne(`${B}/groups/group1/levels`).flush('x', { status: 500, statusText: 'x' });
    httpMock.expectOne(`${B}/groups/group1/share`).flush('x', { status: 500, statusText: 'x' });
    httpMock.expectOne(`${B}/groups/group1/shuttle-tools`).flush({ enabled: false });
    httpMock.expectOne(`${B}/groups/group1/cross-session-history`).flush('x', { status: 500, statusText: 'x' });
    await harness.fixture.whenStable();
    await tick();
    expect(list().querySelectorAll('.value').length).toBe(0);
    expect(list().querySelector('[data-section="players"]')?.textContent).toContain('รายชื่อและข้อมูลติดต่อของผู้เล่น');
  });

  it('values are fetched once, not on every reopen', async () => {
    await open();
    trigger().click();
    await harness.fixture.whenStable();
    flushValues();
    trigger().click();
    trigger().click();
    await harness.fixture.whenStable();
    // httpMock.verify() in afterEach fails on any second fetch
  });

  it('Escape closes settings and returns focus to the trigger', async () => {
    await open();
    trigger().click();
    await harness.fixture.whenStable();
    flushValues();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await harness.fixture.whenStable();
    expect(list().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it('?settings=<section> reopens settings, focuses that row, then drops the parameter', async () => {
    await open('/g/group1?settings=levels');
    flushValues();
    await harness.fixture.whenStable();
    await tick();
    expect(list().hidden).toBe(false);
    expect((document.activeElement as HTMLElement).dataset['section']).toBe('levels');
    expect(TestBed.inject(Router).url).toBe('/g/group1');
  });

  it('an unknown ?settings value opens settings without moving focus', async () => {
    await open('/g/group1?settings=bogus');
    flushValues();
    await harness.fixture.whenStable();
    await tick();
    expect(list().hidden).toBe(false);
    expect((document.activeElement as HTMLElement | null)?.dataset?.['section']).toBeUndefined();
  });

  it('a 404 shows not-found — no settings, no start, nothing to fill in', async () => {
    await harness.navigateByUrl('/g/group1', GroupHome);
    httpMock.expectOne(`${B}/groups/group1`).flush('x', { status: 404, statusText: 'Not Found' });
    httpMock.expectOne(`${B}/groups/group1/sessions`).flush([]);
    await harness.fixture.whenStable();
    expect(el().textContent).toContain('ไม่พบก๊วนนี้');
    expect(el().querySelector('[data-settings-trigger]')).toBeNull();
    expect(el().querySelector('[data-start]')).toBeNull();
  });

  it('a network failure is a retryable error, not not-found', async () => {
    const page = await harness.navigateByUrl('/g/group1', GroupHome);
    httpMock.expectOne(`${B}/groups/group1`).flush('x', { status: 0, statusText: 'Network' });
    httpMock.expectOne(`${B}/groups/group1/sessions`).flush([]);
    await harness.fixture.whenStable();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('โหลดก๊วนไม่สำเร็จ');
    expect(el().textContent).not.toContain('ไม่พบก๊วนนี้');
    void page.load();
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: 'ก๊วนอังคาร', lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/sessions`).flush([]);
    await harness.fixture.whenStable();
    expect(el().querySelector('h1')?.textContent).toContain('ก๊วนอังคาร');
  });

  it('opens a legacy 8-hex group the same way', async () => {
    await harness.navigateByUrl('/g/abcd1234', GroupHome);
    httpMock.expectOne(`${B}/groups/abcd1234`).flush({ code: 'abcd1234', name: 'เก่า', lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/abcd1234/sessions`).flush([]);
    await harness.fixture.whenStable();
    expect(el().querySelector('h1')?.textContent).toContain('เก่า');
  });
});
```

In `web/src/app/app.routes.spec.ts`, import `GroupHome`. Change the test `'/g/:groupCode resolves to GroupEntry'` to resolve `GroupHome`, and add:

```ts
    it('/g/:groupCode/start resolves to GroupEntry', async () => {
      const harness = await RouterTestingHarness.create();
      expect(await harness.navigateByUrl('/g/abc123/start', GroupEntry)).toBeInstanceOf(GroupEntry);
    });
```

Then add `['/g/abc123/start', 'roster entry'],` to the signed-out redirect table.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd web && npx ng test --watch=false --include=src/app/pages/group-home/group-home.spec.ts --include=src/app/app.routes.spec.ts`
Expected: FAIL, because the module cannot be resolved.

- [ ] **Step 3: Implement the component**

`web/src/app/pages/group-home/group-home.ts`:

```ts
import { HttpErrorResponse } from '@angular/common/http';
import { Component, ElementRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { Group } from '../../core/group.model';
import type { GroupSession } from '../../core/group-session.model';
import { RosterService } from '../../core/roster.service';
import { isSettingsSection, type SettingsSection } from '../../core/settings-sections';
import { PressDirective } from '../../core/motion/press.directive';
import { Icon } from '../../shared/icon/icon';

interface RowValues {
  players?: number;
  levels?: { mode: 'standard' | 'custom'; count: number };
  shared?: boolean;
  advanced?: { shuttleTools: boolean; crossSessionHistory: boolean };
}

/**
 * A saved group's home. Settings live beside the group's name — one labelled
 * disclosure, closed by default, above the session actions, and it stays
 * there however much history the group grows (spec: Group home and settings).
 * Opening it may push the session actions down; that is the approved order.
 * The resume link sits in the header instead, so it never leaves the screen.
 *
 * A missing group is "not found", never a blank group to fill in: creating
 * happens only at /groups/new.
 */
@Component({
  selector: 'app-group-home',
  imports: [RouterLink, PressDirective, Icon],
  templateUrl: './group-home.html',
  styleUrl: './group-home.css',
  host: { '(document:keydown.escape)': 'closeOnEscape()' },
})
export class GroupHome {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly roster = inject(RosterService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly groupCode = this.route.snapshot.paramMap.get('groupCode')!;
  readonly status = signal<'loading' | 'ready' | 'not-found' | 'error'>('loading');
  readonly group = signal<Group | null>(null);
  readonly sessions = signal<GroupSession[]>([]);
  readonly settingsOpen = signal(false);
  readonly values = signal<RowValues>({});
  private valuesRequested = false;

  readonly latest = computed(() => {
    const code = this.group()?.lastSessionCode;
    if (!code) return null;
    return { code, date: this.sessions().find((s) => s.code === code)?.date ?? null };
  });

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.status.set('loading');
    try {
      const [group, sessions] = await Promise.all([
        firstValueFrom(this.roster.getGroup(this.groupCode)),
        firstValueFrom(this.roster.listSessions(this.groupCode)),
      ]);
      this.group.set(group);
      this.sessions.set(sessions);
      this.status.set('ready');
      this.restoreFromQuery();
    } catch (err) {
      this.status.set(err instanceof HttpErrorResponse && err.status === 404 ? 'not-found' : 'error');
    }
  }

  toggleSettings(): void {
    this.setSettings(!this.settingsOpen());
  }

  closeOnEscape(): void {
    if (!this.settingsOpen()) return;
    this.setSettings(false);
    this.host.nativeElement.querySelector<HTMLElement>('[data-settings-trigger]')?.focus();
  }

  rowLink(section: SettingsSection): string[] {
    return section === 'players' || section === 'levels'
      ? ['/g', this.groupCode, section]
      : ['/g', this.groupCode, 'settings', section];
  }

  playersValue(): string | null {
    const n = this.values().players;
    return n === undefined ? null : $localize`:@@group.value.players:${n}:count: คน`;
  }

  levelsValue(): string | null {
    const l = this.values().levels;
    if (!l) return null;
    return l.mode === 'standard'
      ? $localize`:@@group.value.levelsStandard:มาตรฐาน`
      : $localize`:@@group.value.levelsCustom:กำหนดเอง · ${l.count}:count: ระดับ`;
  }

  shareValue(): string | null {
    const s = this.values().shared;
    if (s === undefined) return null;
    return s ? $localize`:@@group.value.shared:แชร์อยู่` : $localize`:@@group.value.notShared:ยังไม่แชร์`;
  }

  advancedValue(): string | null {
    const a = this.values().advanced;
    if (!a) return null;
    const on = Number(a.shuttleTools) + Number(a.crossSessionHistory);
    if (on === 0) return $localize`:@@group.value.allOff:ปิดทั้งหมด`;
    if (on === 2) return $localize`:@@group.value.allOn:เปิดทั้งหมด`;
    return $localize`:@@group.value.oneOn:เปิด 1 จาก 2`;
  }

  /** On = something switched on: shown in the court-soft tint rather than neutral. */
  isOn(section: SettingsSection): boolean {
    const v = this.values();
    if (section === 'levels') return v.levels?.mode === 'custom';
    if (section === 'share') return v.shared === true;
    if (section === 'advanced') return !!v.advanced && (v.advanced.shuttleTools || v.advanced.crossSessionHistory);
    return false;
  }

  private setSettings(open: boolean): void {
    this.settingsOpen.set(open);
    if (open) this.loadValues();
  }

  /**
   * Back from a settings detail lands on /g/:code?settings=<section>: reopen,
   * focus that row, then drop the parameter with replaceUrl so a reload or
   * Back does not reopen settings. The focus waits one macrotask for the rows
   * to render (a render hook here raced test infrastructure elsewhere — see
   * core/motion/reveal.directive.ts).
   */
  private restoreFromQuery(): void {
    const section = this.route.snapshot.queryParamMap.get('settings');
    if (section === null) return;
    this.setSettings(true);
    if (isSettingsSection(section)) {
      setTimeout(() =>
        this.host.nativeElement.querySelector<HTMLElement>(`[data-section="${section}"]`)?.focus()
      );
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { settings: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /**
   * Live values, fetched once, on first open, from the owner-only endpoints —
   * never added to the public GET /groups/:code. A row whose fetch has not
   * answered, or failed, shows its static description only.
   */
  private loadValues(): void {
    if (this.valuesRequested) return;
    this.valuesRequested = true;
    const code = this.groupCode;
    const set = (patch: Partial<RowValues>) => this.values.update((v) => ({ ...v, ...patch }));
    const ignore = () => undefined;
    this.roster.getPlayers(code).subscribe({ next: (p) => set({ players: p.length }), error: ignore });
    this.roster
      .getGroupLevels(code)
      .subscribe({ next: (l) => set({ levels: { mode: l.mode, count: l.levels.length } }), error: ignore });
    this.roster.getShare(code).subscribe({ next: (s) => set({ shared: s.token !== null }), error: ignore });
    Promise.all([firstValueFrom(this.roster.getShuttleTools(code)), firstValueFrom(this.roster.getCrossSessionHistory(code))])
      .then(([shuttle, history]) =>
        set({ advanced: { shuttleTools: shuttle.enabled, crossSessionHistory: history.enabled } })
      )
      .catch(ignore);
  }
}
```

`web/src/app/pages/group-home/group-home.html`:

```html
<div class="page group-home">
  <p><a class="back" [routerLink]="['/']" i18n="@@group.backToList">← ก๊วนของฉัน</a></p>

  @switch (status()) {
    @case ('loading') {
      <p class="muted" role="status" i18n="@@group.loading">กำลังโหลดก๊วน...</p>
    }
    @case ('not-found') {
      <h1 class="group-title" i18n="@@group.notFound">ไม่พบก๊วนนี้</h1>
      <p class="muted" i18n="@@group.notFoundHint">ลิงก์อาจพิมพ์ผิด หรือก๊วนถูกลบไปแล้ว</p>
    }
    @case ('error') {
      <p class="error" role="alert">
        <ng-container i18n="@@group.loadFailed">โหลดก๊วนไม่สำเร็จ</ng-container>
        <button type="button" class="ghost" (click)="load()" i18n="@@entry.retry">ลองอีกครั้ง</button>
      </p>
    }
    @case ('ready') {
      <div class="group-head">
        <h1 class="group-title">{{ group()?.name || groupCode }}</h1>
        <button
          type="button"
          class="ghost settings-trigger"
          data-settings-trigger
          appPress
          aria-controls="group-settings"
          [attr.aria-expanded]="settingsOpen()"
          (click)="toggleSettings()"
        >
          <app-icon name="gear" [size]="18" />
          <ng-container i18n="@@group.settings">ตั้งค่าก๊วน</ng-container>
        </button>
      </div>

      @if (latest(); as last) {
        <a class="resume" data-resume [routerLink]="['/s', last.code]">
          <span class="dot" aria-hidden="true"></span>
          <ng-container i18n="@@group.resumeLast">กลับไปรอบล่าสุด</ng-container>
          @if (last.date) {
            <span class="resume-date">· {{ last.date }}</span>
          }
        </a>
      } @else {
        <p class="muted hint" data-hint i18n="@@group.newHint">บันทึกก๊วนแล้ว เริ่มรอบได้ทันที ระดับผู้เล่นและตัวเลือกอื่นอยู่ใน “ตั้งค่าก๊วน”</p>
      }

      <ul id="group-settings" class="settings" [hidden]="!settingsOpen()" i18n-aria-label="@@group.settingsList" aria-label="ตัวเลือกของก๊วน">
        <li>
          <a class="row" data-section="players" appPress [routerLink]="rowLink('players')" aria-describedby="desc-players val-players">
            <span class="row-text">
              <span class="row-title">
                <ng-container i18n="@@group.row.players">จัดการผู้เล่น</ng-container>
                @if (playersValue(); as v) { <span class="value" id="val-players">{{ v }}</span> }
              </span>
              <span class="row-desc" id="desc-players" i18n="@@group.row.playersDesc">รายชื่อและข้อมูลติดต่อของผู้เล่น</span>
            </span>
            <app-icon class="row-chevron" name="chevron" [size]="18" />
          </a>
        </li>
        <li>
          <a class="row" data-section="levels" appPress [routerLink]="rowLink('levels')" aria-describedby="desc-levels val-levels">
            <span class="row-text">
              <span class="row-title">
                <ng-container i18n="@@group.row.levels">ระดับผู้เล่นของก๊วน</ng-container>
                @if (levelsValue(); as v) { <span class="value" id="val-levels" [class.on]="isOn('levels')">{{ v }}</span> }
              </span>
              <span class="row-desc" id="desc-levels" i18n="@@group.row.levelsDesc">ใช้ระดับมาตรฐาน หรือตั้งระดับของก๊วนเอง</span>
            </span>
            <app-icon class="row-chevron" name="chevron" [size]="18" />
          </a>
        </li>
        <li>
          <a class="row" data-section="share" appPress [routerLink]="rowLink('share')" aria-describedby="desc-share val-share">
            <span class="row-text">
              <span class="row-title">
                <ng-container i18n="@@group.row.share">แชร์หน้าสรุปก๊วน</ng-container>
                @if (shareValue(); as v) { <span class="value" id="val-share" [class.on]="isOn('share')">{{ v }}</span> }
              </span>
              <span class="row-desc" id="desc-share" i18n="@@group.row.shareDesc">ลิงก์สำหรับปักไว้ใน LINE</span>
            </span>
            <app-icon class="row-chevron" name="chevron" [size]="18" />
          </a>
        </li>
        <li>
          <a class="row" data-section="advanced" appPress [routerLink]="rowLink('advanced')" aria-describedby="desc-advanced val-advanced">
            <span class="row-text">
              <span class="row-title">
                <ng-container i18n="@@group.row.advanced">ตั้งค่าขั้นสูง</ng-container>
                @if (advancedValue(); as v) { <span class="value" id="val-advanced" [class.on]="isOn('advanced')">{{ v }}</span> }
              </span>
              <span class="row-desc" id="desc-advanced" i18n="@@group.row.advancedDesc">จดลูกแบดเป็นหมายเลข · ประวัติคู่ข้ามรอบ</span>
            </span>
            <app-icon class="row-chevron" name="chevron" [size]="18" />
          </a>
        </li>
        <li class="manage">
          <a class="row" data-section="manage" appPress [routerLink]="rowLink('manage')" aria-describedby="desc-manage">
            <span class="row-text">
              <span class="row-title" i18n="@@group.row.manage">จัดการก๊วน</span>
              <span class="row-desc" id="desc-manage" i18n="@@group.row.manageDesc">ชื่อก๊วน / ดาวน์โหลดข้อมูล / ลบก๊วน</span>
            </span>
            <app-icon class="row-chevron" name="chevron" [size]="18" />
          </a>
        </li>
      </ul>

      <div class="session-area">
        <button type="button" class="start" data-start appPress [routerLink]="['/g', groupCode, 'start']">
          @if (latest()) {
            <ng-container i18n="@@group.startNext">เริ่มรอบใหม่</ng-container>
          } @else {
            <ng-container i18n="@@group.startFirst">เริ่มรอบแรก</ng-container>
          }
          <app-icon class="start-chevron" name="chevron" [size]="18" />
        </button>
        <p class="muted start-sub" i18n="@@group.startSub">วางรายชื่อจาก LINE หรือเพิ่มรายชื่อเอง</p>
      </div>

      @if (sessions().length > 0) {
        <section class="past">
          <h2 class="label" i18n="@@group.pastSessions">รอบที่ผ่านมา</h2>
          <ul class="session-list">
            @for (s of sessions(); track s.code) {
              <li>
                <a [routerLink]="['/s', s.code]">{{ s.date ?? s.code }}</a>
                @if (s.venue) { <span class="muted">· {{ s.venue }}</span> }
                <span class="muted">· {{ s.matchCount }} <ng-container i18n="@@entry.matches">แมตช์</ng-container></span>
                @if (!s.endedAt) { <span class="live-tag" i18n="@@entry.stillOpen">ยังไม่จบ</span> }
              </li>
            }
          </ul>
        </section>
      }
    }
  }
</div>
```

`web/src/app/pages/group-home/group-home.css`. Open `web/src/app/pages/group-entry/group-entry.css` first and copy its `.session-list` and `.live-tag` rules into the end of this file unchanged.

```css
.back {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  text-decoration: none;
  font-size: var(--text-sm);
}

.group-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.group-title {
  flex: 1;
  min-width: 0;
  font-size: var(--text-2xl);
  margin: var(--space-0) 0 0;
  overflow-wrap: anywhere;
}

.settings-trigger {
  flex: none;
  gap: var(--space-1);
  padding: 0.5rem 0.8rem;
}

.settings-trigger[aria-expanded='true'] {
  background: var(--court-soft);
  border-color: var(--court);
  color: var(--court-ink);
}

.resume {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--tap);
  text-decoration: none;
}

.resume .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--court);
  box-shadow: 0 0 0 3px var(--court-soft);
}

.resume-date {
  font-weight: 400;
  color: var(--ink-soft);
  font-size: var(--text-sm);
}

.hint {
  margin-top: var(--space-1);
  max-width: 34ch;
}

.settings {
  margin: var(--space-3) 0 0;
  padding: var(--space-0) 0;
  list-style: none;
  background: var(--surface);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}

.settings:not([hidden]) {
  animation: settings-in var(--duration-slow) var(--ease-out) both;
}

@keyframes settings-in {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
}

.settings li + li .row {
  border-top: 1px solid var(--line);
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 4.25rem;
  padding: var(--space-2) var(--space-3);
  color: var(--ink);
  font-weight: 400;
  text-decoration: none;
  transition: background-color var(--duration-fast) ease;
}

.row:focus-visible {
  outline-offset: -2px;
}

@media (hover: hover) {
  .row:hover {
    background: var(--court-hover);
  }
}

.settings li:first-child .row {
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
}

.row-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.row-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-0) var(--space-1);
  font-weight: 600;
}

.row-desc {
  color: var(--ink-soft);
  font-size: var(--text-sm);
}

.row-chevron {
  color: var(--ink-faint);
  transform: rotate(-90deg);
}

.value {
  display: inline-flex;
  align-items: center;
  padding: 0 var(--space-1);
  border-radius: var(--radius-pill);
  background: var(--ground-sunk);
  color: var(--ink-soft);
  font-size: var(--text-xs);
  font-weight: 600;
  line-height: 1.7;
  font-variant-numeric: tabular-nums;
}

.value.on {
  background: var(--court-soft);
  color: var(--court-ink);
}

/* Management is a different kind of row: separated by a band of ground. */
.settings li.manage {
  margin-top: var(--space-1);
  border-top: var(--space-1) solid var(--ground);
}

.settings li.manage .row {
  border-top: 0;
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
}

.session-area {
  margin-top: var(--space-4);
}

.start {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
}

.start-chevron {
  transform: rotate(-90deg);
}

.start-sub {
  margin-top: var(--space-1);
  text-align: center;
}

.past {
  margin-top: var(--space-4);
}

@media (prefers-reduced-motion: reduce) {
  .settings:not([hidden]) {
    animation: none;
  }
}
```

- [ ] **Step 4: Routes**

In `web/src/app/app.routes.ts`:
- Change the existing `path: 'g/:groupCode'` entry to load `./pages/group-home/group-home` → `m.GroupHome`.
- Add this entry above `'g/:groupCode/settings/:section'`:

```ts
  {
    // Before 'g/:groupCode'. Guarded: roster entry for a saved group (paste
    // from LINE or build by hand). The group is always created first, at
    // /groups/new — this screen never creates one.
    path: 'g/:groupCode/start',
    canActivate: [adminGuard],
    loadComponent: () => import('./pages/group-entry/group-entry').then((m) => m.GroupEntry),
  },
```

English targets:

| id | Thai | English |
|---|---|---|
| `group.settings` | `ตั้งค่าก๊วน` | `Group settings` |
| `group.settingsList` | `ตัวเลือกของก๊วน` | `Group options` |
| `group.resumeLast` | `กลับไปรอบล่าสุด` | `Back to latest session` |
| `group.newHint` | `บันทึกก๊วนแล้ว เริ่มรอบได้ทันที ระดับผู้เล่นและตัวเลือกอื่นอยู่ใน “ตั้งค่าก๊วน”` | `Group saved — you can start a session now. Player levels and other options are under "Group settings".` |
| `group.row.players` | `จัดการผู้เล่น` | `Players` |
| `group.row.playersDesc` | `รายชื่อและข้อมูลติดต่อของผู้เล่น` | `Names and contact details` |
| `group.row.levels` | `ระดับผู้เล่นของก๊วน` | `Player levels` |
| `group.row.levelsDesc` | `ใช้ระดับมาตรฐาน หรือตั้งระดับของก๊วนเอง` | `Use the standard levels, or set your own` |
| `group.row.shareDesc` | `ลิงก์สำหรับปักไว้ใน LINE` | `A link to pin in LINE` |
| `group.row.advancedDesc` | `จดลูกแบดเป็นหมายเลข · ประวัติคู่ข้ามรอบ` | `Numbered shuttles · partner history across sessions` |
| `group.row.manageDesc` | `ชื่อก๊วน / ดาวน์โหลดข้อมูล / ลบก๊วน` | `Group name / download data / delete group` |
| `group.value.players` | `{$INTERPOLATION} คน` | `{$INTERPOLATION} players` |
| `group.value.levelsStandard` | `มาตรฐาน` | `Standard` |
| `group.value.levelsCustom` | `กำหนดเอง · {$INTERPOLATION} ระดับ` | `Custom · {$INTERPOLATION} levels` |
| `group.value.shared` | `แชร์อยู่` | `Shared` |
| `group.value.notShared` | `ยังไม่แชร์` | `Not shared` |
| `group.value.allOff` | `ปิดทั้งหมด` | `All off` |
| `group.value.allOn` | `เปิดทั้งหมด` | `All on` |
| `group.value.oneOn` | `เปิด 1 จาก 2` | `1 of 2 on` |
| `group.startFirst` | `เริ่มรอบแรก` | `Start first session` |
| `group.startNext` | `เริ่มรอบใหม่` | `Start new session` |
| `group.startSub` | `วางรายชื่อจาก LINE หรือเพิ่มรายชื่อเอง` | `Paste from LINE, or add players yourself` |
| `group.pastSessions` | `รอบที่ผ่านมา` | `Past sessions` |

For the two `${…}:count:` messages, copy the exact placeholder markup from an existing interpolated unit in `messages.en.xlf`, for example `entry.manualAddedAnnounce`. Use `<x id="count" equiv-text="…"/>` as that file does. Do not use the `{$INTERPOLATION}` shorthand shown in the table.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd web && npx ng test --watch=false --include=src/app/pages/group-home/group-home.spec.ts --include=src/app/app.routes.spec.ts`
Expected: PASS.

`group-entry.spec.ts` still passes unchanged at this point, because it mounts `GroupEntry` directly with a stubbed route. Check that:

Run: `cd web && npx ng test --watch=false --include=src/app/pages/group-entry/group-entry.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/app/pages/group-home web/src/app/app.routes.ts web/src/app/app.routes.spec.ts web/src/locale/messages.en.xlf
git commit -m "feat(web): group home with settings beside the name; roster entry moves to /start"
```

---

### Task 6: Slim `GroupEntry` to roster entry, with a draft that survives settings

**Files:**
- Modify: `web/src/app/pages/group-entry/group-entry.ts`
- Modify: `web/src/app/pages/group-entry/group-entry.html`
- Modify: `web/src/app/pages/group-entry/group-entry.css`
- Modify: `web/src/app/pages/group-entry/group-entry.spec.ts`

**Interfaces:**
- Consumes: `RosterDraftService` and `RosterDraft` (Task 2), and `RosterService.getGroup`, `getPlayers`, `parseRoster`, `createSession`, `getGroupLevels`.
- Produces: `GroupEntry.groupStatus: Signal<'loading' | 'ready' | 'not-found' | 'error'>` and `GroupEntry.discardDraft(): void`.

- [ ] **Step 1: Update the spec setup and remove the tests whose features moved**

In `group-entry.spec.ts`, change `beforeEach` so the group exists by default and no sessions request is expected:

```ts
    // Constructor reads the saved group. The group always exists before this
    // screen now — it is created at /groups/new.
    httpMock
      .expectOne(`${B}/groups/group1`)
      .flush({ code: 'group1', name: 'ก๊วนทดสอบ', lastSessionCode: null });
    await fixture.whenStable();
```

Delete the line `httpMock.expectOne(`${B}/groups/group1/sessions`).flush([]);`. Also add `TestBed.inject(RosterDraftService).clear('group1');` to `afterEach`, before `httpMock.verify()`, so no draft leaks between tests. Import `RosterDraftService` from `../../core/roster-draft.service`.

Delete these tests. Their behaviour moved to `GroupHome`/`GroupSettingsDetail` (Tasks 4–5) or no longer exists:
- `'links back to the group list'` (replaced below)
- `'links to the player roster page'`
- `'groupName is empty when no Group exists yet'`
- `'lastSessionCode is null when no Group exists yet'`
- `'parse shows an error and stays in the paste state when the group name is …'`
- `'startManual shows an error and stays in the paste state when the group na…'`
- `'saveGroupName does not call the server for a brand-new group …'`
- `'saveGroupName sends the group name via renameGroup'`
- `'preserves the group name and allows a retry when renaming fails'`
- `'lists past sessions for the group'`
- `'only enables delete once the group name is typed back'`
- `'does not delete when the confirmation does not match'`
- `'deletes the group and returns to the landing page'`
- the whole `describe('advanced group settings', …)` block
- `'prefills groupName and lastSessionCode from the fetched Group'`

Replace `'startManual claims the group with an empty parse and lands on an empty co…'` with the test below. Manual start no longer calls parse, because the group already exists:

```ts
  it('startManual reads the group players and lands on an empty confirm screen without parsing', async () => {
    const done = component.startManual();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await done;
    httpMock.expectNone(`${B}/groups/group1/parse`);
    expect(component.state()).toBe('confirm');
    expect(component.rosterReviews()).toEqual([]);
  });
```

Replace `'startManual allows a retry when the claim request fails'` with:

```ts
  it('startManual allows a retry when reading players fails', async () => {
    const first = component.startManual();
    httpMock.expectOne(`${B}/groups/group1/players`).flush('x', { status: 500, statusText: 'x' });
    await first;
    expect(component.state()).toBe('paste');
    expect(component.pasteError()).toContain('อ่านรายชื่อไม่สำเร็จ');

    const second = component.startManual();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await second;
    expect(component.state()).toBe('confirm');
  });
```

Any remaining test that asserts the parse request body's `groupName` should now expect the loaded name, `'ก๊วนทดสอบ'`, unless the test itself calls `component.groupName.set(...)` first.

- [ ] **Step 2: Add the new tests**

```ts
  it('names the group in a back link to group home', () => {
    const back = fixture.nativeElement.querySelector('a.back') as HTMLAnchorElement;
    expect(back.textContent).toContain('ก๊วนทดสอบ');
    expect(back.getAttribute('href')).toBe('/g/group1');
  });

  it('titles a group without sessions เริ่มรอบแรก', () => {
    expect(fixture.nativeElement.querySelector('h1')?.textContent).toContain('เริ่มรอบแรก');
  });

  it('keeps no settings on this screen', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).not.toContain('ตั้งค่าขั้นสูง');
    expect(text).not.toContain('ลบก๊วนนี้');
    expect(fixture.nativeElement.querySelector('app-share-dashboard-panel')).toBeNull();
  });

  it('restores a pasted draft after leaving and coming back', async () => {
    component.rawText.set('1. ตั้ม\n2. มด');
    fixture.destroy();

    const again = TestBed.createComponent(GroupEntry);
    httpMock
      .expectOne(`${B}/groups/group1`)
      .flush({ code: 'group1', name: 'ก๊วนทดสอบ', lastSessionCode: null });
    await again.whenStable();
    expect(again.componentInstance.rawText()).toBe('1. ตั้ม\n2. มด');
    again.destroy();
  });

  it('restores a confirm-step draft — reviews, manual rows and the idempotency key — after a settings detour', async () => {
    const done = component.startManual();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    await done;
    component.addExisting('p1');
    const review = component.rosterReviews()[0];
    expect(component.isManualReview(review)).toBe(true);
    fixture.destroy();

    const again = TestBed.createComponent(GroupEntry);
    httpMock
      .expectOne(`${B}/groups/group1`)
      .flush({ code: 'group1', name: 'ก๊วนทดสอบ', lastSessionCode: null });
    await again.whenStable();
    const restored = again.componentInstance;
    expect(restored.state()).toBe('confirm');
    expect(restored.rosterReviews()).toHaveLength(1);
    expect(restored.isManualReview(restored.rosterReviews()[0])).toBe(true);
    again.destroy();
  });

  it('clears the draft once the session is created', async () => {
    component.rawText.set('1. ตั้ม\n2. เกียร์\n3. มด\n4. มะนาว');
    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: fourNewPlayers(),
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await parsePromise;
    component.date.set('2026-09-08');
    component.courtCount.set(2);

    const confirmPromise = component.confirmRoster();
    httpMock.expectOne(`${B}/sessions`).flush({ code: 'sess1' });
    await confirmPromise;
    fixture.destroy();
    expect(TestBed.inject(RosterDraftService).get('group1')).toBeNull();
  });

  it('discardDraft empties the roster and returns to the paste box', async () => {
    const done = component.startManual();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await done;
    component.discardDraft();
    expect(component.state()).toBe('paste');
    expect(component.rawText()).toBe('');
    expect(TestBed.inject(RosterDraftService).get('group1')).toBeNull();
  });

  it('a missing group is not found here too, with no paste box', async () => {
    fixture.destroy();
    const again = TestBed.createComponent(GroupEntry);
    httpMock.expectOne(`${B}/groups/group1`).flush('x', { status: 404, statusText: 'Not Found' });
    await again.whenStable();
    expect(again.nativeElement.textContent).toContain('ไม่พบก๊วนนี้');
    expect(again.nativeElement.querySelector('textarea')).toBeNull();
    again.destroy();
  });
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `cd web && npx ng test --watch=false --include=src/app/pages/group-entry/group-entry.spec.ts`
Expected: FAIL. The constructor still issues `GET …/sessions`, `startManual` still posts parse, `discardDraft` is missing, and there is no draft restore.

- [ ] **Step 4: Implement in `group-entry.ts`**

1. Imports. Add `DestroyRef`, `inject` from `@angular/core` and `RosterDraftService`, `type RosterDraft` from `../../core/roster-draft.service`. Remove the `ShareDashboardPanel` import and drop it from `imports: [...]`. Remove `type GroupSession`.
2. Delete these members: `groupExists`, `renameError`, `pastSessions`, `showDanger`, `showAdvanced`, `showShare`, `shuttleTools`, `crossSessionHistory`, `advancedUnavailable`, `advancedError`, `advancedSaving`, `advancedLoaded`, `deleteConfirmText`, `dangerError`, `isRenaming`, `canDelete`, `exportGroup()`, `deleteGroup()`, `saveGroupName()`, `toggleAdvanced()`, `setAdvanced()`.
3. Add these fields:

```ts
  /** The saved group this roster is for. Not found is a dead end here: groups are created at /groups/new. */
  readonly groupStatus = signal<'loading' | 'ready' | 'not-found' | 'error'>('loading');
  private readonly drafts = inject(RosterDraftService);
  /** Set once the session exists, so leaving afterwards does not save a stale draft back. */
  private sessionCreated = false;
```

4. Replace the constructor body:

```ts
    this.groupCode = route.snapshot.paramMap.get('groupCode')!;
    void this.loadGroup();
    const draft = this.drafts.get(this.groupCode);
    if (draft) this.applyDraft(draft);
    inject(DestroyRef).onDestroy(() => this.persistDraft());
```

5. Add these methods:

```ts
  async loadGroup(): Promise<void> {
    this.groupStatus.set('loading');
    try {
      const group = await firstValueFrom(this.rosterService.getGroup(this.groupCode));
      this.groupName.set(group.name ?? '');
      this.lastSessionCode.set(group.lastSessionCode);
      this.groupStatus.set('ready');
    } catch (err) {
      this.groupStatus.set(err instanceof HttpErrorResponse && err.status === 404 ? 'not-found' : 'error');
    }
  }

  /**
   * Leaving for group settings must not lose a roster in progress. An empty
   * paste box has nothing worth keeping, and a created session has already
   * consumed the draft.
   */
  private persistDraft(): void {
    if (this.sessionCreated) return;
    if (this.state() === 'paste' && !this.rawText().trim()) {
      this.drafts.clear(this.groupCode);
      return;
    }
    this.drafts.save(this.groupCode, {
      state: this.state(),
      rawText: this.rawText(),
      date: this.date(),
      venue: this.venue(),
      courtCount: this.courtCount(),
      warnings: this.warnings(),
      unrecognizedLines: this.unrecognizedLines(),
      rosterReviews: this.rosterReviews(),
      waitlistReviews: this.waitlistReviews(),
      players: this.players(),
      manualReviews: new Set(this.manualReviews),
      openReviews: new Set(this.openReviews),
      idempotencyKey: this.creationIdempotencyKey,
    });
  }

  private applyDraft(draft: RosterDraft): void {
    this.rawText.set(draft.rawText);
    this.date.set(draft.date);
    this.venue.set(draft.venue);
    this.courtCount.set(draft.courtCount);
    this.warnings.set(draft.warnings);
    this.unrecognizedLines.set(draft.unrecognizedLines);
    this.rosterReviews.set(draft.rosterReviews);
    this.waitlistReviews.set(draft.waitlistReviews);
    this.players.set(draft.players);
    for (const r of draft.manualReviews) this.manualReviews.add(r);
    for (const r of draft.openReviews) this.openReviews.add(r);
    this.creationIdempotencyKey = draft.idempotencyKey;
    this.state.set(draft.state);
    if (draft.state === 'confirm') void this.loadLadder();
  }

  /** Throw the roster away and start from an empty paste box. */
  discardDraft(): void {
    this.drafts.clear(this.groupCode);
    this.rawText.set('');
    this.rosterReviews.set([]);
    this.waitlistReviews.set([]);
    this.manualReviews.clear();
    this.openReviews.clear();
    this.creationIdempotencyKey = null;
    this.pasteError.set(null);
    this.confirmError.set(null);
    this.state.set('paste');
  }
```

6. `parse()`: delete the `if (!this.groupName().trim()) { … errNoGroupName … }` block. Change the parse call to send `this.groupName() || this.groupCode`. The legacy endpoint requires a non-empty `groupName` but never renames an existing group, so the fallback is harmless.
7. `startManual()`: delete the `errNoGroupName` block and the `parseRoster(…, '')` line. Its `try` body becomes:

```ts
      const players = await firstValueFrom(this.rosterService.getPlayers(this.groupCode));
      this.rawText.set('');
      this.enterConfirm(
        {
          header: { isoDate: todayIso(), venue: null, courtCount: null },
          warnings: [],
          unrecognizedLines: [],
          rosterReviews: [],
          waitlistReviews: [],
        },
        players
      );
```

Rewrite its doc comment to say the group already exists, so a manual start only needs the group's players.

8. `confirmRoster()`: on success, before `navigateByUrl`, add:

```ts
      this.sessionCreated = true;
      this.drafts.clear(this.groupCode);
```

Change the failure string id to the session meaning: `$localize`:@@entry.createSessionFailed:สร้างรอบไม่สำเร็จ กรุณาลองอีกครั้ง``. It creates a session, not a group. Update any spec assertion on the old text.

9. Update the comment on `loadLadder`/`ladder` that says "after the parse has created the group when it is brand new". The group always exists now.

- [ ] **Step 5: Implement in `group-entry.html`**

Replace the opening of the template, from `<div class="page group-entry">` through the end of the first `entry-card` (the name field, rename messages and resume link), with:

```html
<div class="page group-entry">
  <p><a class="back" [routerLink]="['/g', groupCode]">← {{ groupName() || groupCode }}</a></p>

  @if (groupStatus() === 'not-found') {
    <h1 class="entry-title" i18n="@@group.notFound">ไม่พบก๊วนนี้</h1>
    <p class="muted" i18n="@@group.notFoundHint">ลิงก์อาจพิมพ์ผิด หรือก๊วนถูกลบไปแล้ว</p>
  } @else if (groupStatus() === 'error') {
    <p class="error" role="alert">
      <ng-container i18n="@@group.loadFailed">โหลดก๊วนไม่สำเร็จ</ng-container>
      <button type="button" class="ghost" (click)="loadGroup()" i18n="@@entry.retry">ลองอีกครั้ง</button>
    </p>
  } @else {
  <h1 class="entry-title">
    @if (lastSessionCode()) {
      <ng-container i18n="@@group.startNext">เริ่มรอบใหม่</ng-container>
    } @else {
      <ng-container i18n="@@group.startFirst">เริ่มรอบแรก</ng-container>
    }
  </h1>
```

Then:
- Delete the `@if (state() === 'paste' && pastSessions().length > 0) { … }` block.
- Delete the whole `@if (state() === 'paste') { <p><a …players…` block, which includes the two links, the `<hr class="rule" />`, the `group-actions` row and the share/advanced/danger panels.
- Disable the paste card's two buttons while `groupStatus() !== 'ready'`, by adding `|| groupStatus() !== 'ready'` to their `[disabled]`.
- In the confirm block, directly after the `<hr class="rule" />` that follows the notes, add:

```html
    <p>
      <button type="button" class="ghost" data-discard [disabled]="isSubmitting()" (click)="discardDraft()" i18n="@@entry.discardDraft">ล้างรายชื่อแล้วเริ่มใหม่</button>
    </p>
```

- Close the new `} @else {` with `}` immediately before the final `</div>`.

- [ ] **Step 6: Implement in `group-entry.css`**

Delete these rules, which now only exist on the settings screen and group home: `.danger-zone`, `.danger-zone button`, `.advanced-settings`, `.switch-row`, `.switch-row input`, `.switch-text`, `.switch-title`, `.group-actions`, `.session-list`, `.live-tag`, `.resume-link`. Search each selector first and leave any rule the remaining template still uses. Then add:

```css
.back {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  text-decoration: none;
  font-size: var(--text-sm);
}

.entry-title {
  font-size: var(--text-2xl);
  overflow-wrap: anywhere;
}
```

English targets: `entry.discardDraft` = `Clear the list and start over`; `entry.createSessionFailed` = `Couldn't create the session. Please try again.`

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `cd web && npx ng test --watch=false --include=src/app/pages/group-entry/group-entry.spec.ts --include=src/app/pages/group-home/group-home.spec.ts --include=src/app/app.routes.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src/app/pages/group-entry web/src/locale/messages.en.xlf
git commit -m "refactor(web): group entry becomes roster-only at /start; draft survives a settings detour"
```

---

### Task 7: Back links from players and levels return to the open settings row

**Files:**
- Modify: `web/src/app/pages/player-roster/player-roster.html:4`
- Modify: `web/src/app/pages/group-levels/group-levels.html:2`
- Modify: `web/src/app/pages/player-roster/player-roster.ts` and `web/src/app/pages/group-levels/group-levels.ts` (add `settingsReturn` to each component's fields)
- Test: `web/src/app/pages/player-roster/player-roster.spec.ts`, `web/src/app/pages/group-levels/group-levels.spec.ts`

**Interfaces:**
- Consumes: `settingsReturn` (Task 2).

- [ ] **Step 1: Write the failing tests**

Add to each spec. In `player-roster.spec.ts`:

```ts
  it('its back link returns to the group home with settings open on this row', () => {
    const back = [...fixture.nativeElement.querySelectorAll('a')].find((a: HTMLAnchorElement) =>
      a.textContent?.includes('กลับ')
    ) as HTMLAnchorElement;
    expect(back.getAttribute('href')).toBe('/g/group1?settings=players');
  });
```

Add the same test to `group-levels.spec.ts`. That spec stubs the group code `g1`, so it expects `/g/g1?settings=levels`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd web && npx ng test --watch=false --include=src/app/pages/player-roster/player-roster.spec.ts --include=src/app/pages/group-levels/group-levels.spec.ts`
Expected: FAIL, because the href is `/g/group1`.

- [ ] **Step 3: Implement**

In each component class, add:

```ts
  /** Back to group home with the settings list reopened on this row. */
  protected readonly back = settingsReturn(this.groupCode, 'players'); // 'levels' in group-levels.ts
```

Import it with `import { settingsReturn } from '../../core/settings-sections';`. In `player-roster.ts` `groupCode` is assigned in the constructor, so compute `back` there instead: `this.back = settingsReturn(this.groupCode, 'players');`, with the field declared as `protected readonly back: ReturnType<typeof settingsReturn>;`.

Change the anchors:
- `player-roster.html:4`: `<a [routerLink]="back.commands" [queryParams]="back.queryParams" i18n="@@playerRoster.back">← กลับ</a>`
- `group-levels.html:2`: `<p><a [routerLink]="back.commands" [queryParams]="back.queryParams" i18n="@@levels.back">← กลับ</a></p>`

- [ ] **Step 4: Run the tests and confirm they pass**

Run the same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/pages/player-roster web/src/app/pages/group-levels
git commit -m "feat(web): players and levels return to their open settings row"
```

---

### Task 8: Vocabulary sweep — ก๊วน is the group, รอบ is the session

**Files:**
- Modify: every template or `.ts` holding a string listed below (find each with `grep -rn '<old text>' web/src/app`)
- Modify: every `*.spec.ts` asserting an old string
- Modify: `web/src/locale/messages.xlf` (regenerated) and `web/src/locale/messages.en.xlf`

- [ ] **Step 1: Change these source strings**

Keep each id; change only the Thai text.

| id | old | new |
|---|---|---|
| `display.sessionEnded` | จบก๊วนแล้ว | จบรอบแล้ว |
| `dashboard.sessionEnded` | จบก๊วนแล้ว | จบรอบแล้ว |
| `court.sessionEnded` | จบก๊วนแล้ว | จบรอบแล้ว |
| `display.notFound` | ไม่พบก๊วนนี้ | ไม่พบรอบนี้ |
| `dashboard.notFound` | ไม่พบก๊วนนี้ | ไม่พบรอบนี้ |
| `summary.notFound` | ไม่พบก๊วนนี้ | ไม่พบรอบนี้ |
| `dashboard.endSession` | จบก๊วน | จบรอบ |
| `dashboard.copySummaryLink` | ลิงก์สรุปก๊วน | ลิงก์สรุปรอบ |
| `summary.title` | สรุปก๊วน | สรุปรอบ |
| `summary.noMatches` | ก๊วนนี้ยังไม่มีการแข่งขัน | รอบนี้ยังไม่มีการแข่งขัน |
| `bill.backLive` | ← กลับไปหน้าคุมก๊วน | ← กลับไปหน้าคุมรอบ |
| `bill.back` | ← กลับไปสรุปก๊วน | ← กลับไปสรุปรอบ |
| `bill.prefilled` | ใช้ค่าจากก๊วนครั้งก่อน | ใช้ค่าจากรอบก่อน |
| `bill.warnUnknownUse` | …แก้ในหน้าสรุปก๊วนก่อน | …แก้ในหน้าสรุปรอบก่อน |
| `bill.settledHint` | ยกเลิกเช็คเอาต์ได้ที่หน้าก๊วนระหว่างเล่นเท่านั้น | ยกเลิกเช็คเอาต์ได้ที่หน้าคุมรอบระหว่างเล่นเท่านั้น |
| `checkout.ratesHint` | …หน้าคิดเงินตอนจบก๊วน… | …หน้าคิดเงินตอนจบรอบ… |
| `checkout.err.unknownUse` | …แก้ในหน้าสรุปก๊วนก่อน | …แก้ในหน้าสรุปรอบก่อน |
| `checkout.err.disabled` | ก๊วนนี้ไม่ได้เปิดเครื่องมือลูกแบด | รอบนี้ไม่ได้เปิดเครื่องมือลูกแบด |
| `checkout.err.ended` | ก๊วนนี้จบไปแล้ว | รอบนี้จบไปแล้ว |
| `err.code.sessionEnded` | ก๊วนนี้จบไปแล้ว | รอบนี้จบไปแล้ว |
| `err.code.sessionNotFound` | ไม่พบก๊วนนี้ | ไม่พบรอบนี้ |
| `err.code.invalidSessionState` | ข้อมูลก๊วนนี้ผิดปกติ… | ข้อมูลรอบนี้ผิดปกติ… |
| `err.code.rosterPlayerNotFound` | ไม่พบผู้เล่นคนนี้ในก๊วน | ไม่พบผู้เล่นคนนี้ในรอบนี้ |
| `err.code.rosterDuplicate` | ผู้เล่นคนนี้อยู่ในก๊วนแล้ว | ผู้เล่นคนนี้อยู่ในรอบนี้แล้ว |
| `err.code.shuttleTrackingDisabled` | ก๊วนนี้ไม่ได้เปิดการจดลูกแบด | รอบนี้ไม่ได้เปิดการจดลูกแบด |
| `err.endSession` | จบก๊วนไม่สำเร็จ | จบรอบไม่สำเร็จ |
| `levels.err.activeSession` | ยังมีก๊วนที่ไม่ได้จบ แก้ระดับไม่ได้ จบก๊วนก่อนแล้วค่อยแก้ | ยังมีรอบที่ไม่ได้จบ แก้ระดับไม่ได้ จบรอบก่อนแล้วค่อยแก้ |
| `walkIn.alreadyOnRoster` | {{ match.name }} อยู่ในก๊วนคืนนี้แล้ว — เปิดจากชิปรายชื่อ | {{ match.name }} อยู่ในรอบนี้แล้ว — เปิดจากชิปรายชื่อ |
| `home.removeWarning` | …ทั้งผู้เล่น ก๊วนย้อนหลัง และผลแมตช์… | …ทั้งผู้เล่น รอบย้อนหลัง และผลแมตช์… |
| `home.sessionsSuffix` | ` นัด` | ` รอบ` |

The public group dashboard's empty-state and past-sessions strings use ids that collide with the session dashboard's `dashboard.*` names. Find them with `grep -n 'ก๊วนที่เล่น\|ก๊วนที่ผ่านมา' web/src/app/pages/group-dashboard/group-dashboard.html`. Change ยังไม่มีก๊วนที่เล่น → ยังไม่มีรอบที่เล่น, and ก๊วนที่ผ่านมา → รอบที่ผ่านมา.

**Do not change:**
- group-meaning strings: `home.*` titles, `levels.*` titles, `playerRoster.*`, `share.*`, `entry.groupName`, the delete strings, `addRule.persistHint`, `profile.partnersLast30Days`, `admin.*`
- `dashboard.notFoundHint2` (a session link dies when its group is deleted)
- `dashboard.unnamed` (a group-name fallback)
- the idioms `bill.hostFee` and `admin.roleHost`
- server Thai strings in `server/src/admin/admin.service.ts`, which all name groups

- [ ] **Step 2: Remove the obsolete strings**

`entry.advancedUnavailable` and `entry.pastSessions` left `group-entry.html` in Task 6, and `share.unavailable` left in Task 4. Confirm none remains: `grep -rn 'advancedUnavailable\|entry.pastSessions\|share.unavailable' web/src` should print nothing. Delete their units from `messages.en.xlf`.

- [ ] **Step 3: Check for leftovers**

Run `grep -rn 'นัด' web/src/app --include='*.html' --include='*.ts' | grep -v spec`. Expected: no UI string. Then run `grep -rn 'จบก๊วน\|สรุปก๊วน\|ก๊วนนี้จบ\|ก๊วนที่ผ่านมา\|ก๊วนครั้งก่อน' web/src/app | grep -v spec`. Expected: nothing.

- [ ] **Step 4: Regenerate the source catalogue and sync the English file**

Run: `cd web && npx ng extract-i18n --format=xlf --output-path=src/locale`

Review `git diff web/src/locale/messages.xlf`. Expected: changed `<source>` text for the ids above, new `group.*`/`share.loadFailed`/`entry.discardDraft`/`entry.createSessionFailed` units, removed obsolete units, and line-number churn only in touched files. Then, in `messages.en.xlf`, update the `<source>` of every changed id to the new Thai. Keep each `<target>`, and adjust any English target that said "group" where it meant the session. Check that every id in `messages.xlf` has a unit in `messages.en.xlf`:

```bash
cd web && diff <(grep -o 'trans-unit id="[^"]*"' src/locale/messages.xlf | sort -u) <(grep -o 'trans-unit id="[^"]*"' src/locale/messages.en.xlf | sort -u) | grep '^<'
```

Expected: no output.

- [ ] **Step 5: Update the specs that assert old text**

For each old string in the table, run `grep -rln '<old>' web/src/app --include='*.spec.ts'` and update the expected text.

- [ ] **Step 6: Run everything**

Run: `cd web && npx ng test --watch=false && npm run build`
Expected: all specs PASS, and the localized build (th + en) succeeds with no missing-translation or duplicate-id warnings for the new ids.

- [ ] **Step 7: Commit**

```bash
git add web/src
git commit -m "fix(i18n): ก๊วน names the group, รอบ names the session, across the app"
```

---

### Task 9: Docs, acceptance, and the full suite

**Files:**
- Modify: `CLAUDE.md` (the routes list near "Three routes, access split is fixed")
- Modify: `docs/overview.md` (line 65's table row, "How a session runs" around line 631, the manual-roster paragraph around line 747)
- Modify: `PRODUCT.md` ("Capabilities and Constraints" first bullet)
- Modify: `docs/superpowers/specs/2026-10-13-group-creation-settings-design.md`
- Move: the spec to `docs/archive/specs/`, and this plan to `docs/archive/plans/`

- [ ] **Step 1: Update the route docs**

In `CLAUDE.md`, replace the line `` - `/g/:groupCode` — group entry (admin-guarded) `` with:

```
- `/groups/new` — name-only group creation (admin-guarded)
- `/g/:groupCode` — group home: name, settings disclosure, resume and session actions (admin-guarded)
- `/g/:groupCode/start` — roster entry for a saved group, paste or manual (admin-guarded)
- `/g/:groupCode/settings/:section` — share / advanced / manage (admin-guarded)
```

In `docs/overview.md`:
- In "How a session runs", replace the `/g/:groupCode` bullet with the same four routes. Add one sentence of why: the group is saved by name first, so settings and levels can be prepared before any roster, and a missing group is "not found", never silently created.
- In the line-65 table row and the line-747 paragraph, replace "on the group-entry screen claims/creates the group exactly as a paste would" with: "on the roster screen (`/g/:groupCode/start`) starts an empty confirm step for the already-saved group — creation happens only at `/groups/new` (`POST /groups`); `GroupsService.parse`'s create-or-own remains for older clients only".

In `PRODUCT.md`, change "landing, group entry, session dashboard" to "landing, group creation, group home and its settings and roster screens, session dashboard".

- [ ] **Step 2: Run the full suites**

Run: `npm test` from the repo root, which runs engines, server and web. Then run `cd server && npm run lint` and `cd web && npm run build`.
Expected: PASS everywhere.

- [ ] **Step 3: Verify in a real browser, at 375px and desktop, light and dark**

Start the server (`cd server && npm run start:dev`) and the web app (`cd web && npm start`), sign in, then walk through:
1. Create a group → land on its home.
2. Open settings and see the values.
3. Open levels → back → settings is open on levels, and the URL has no `?settings`.
4. Start a session → paste a roster → go back home → settings → advanced → back → start: the paste is still there.
5. Confirm the session.
6. Return to the group: the resume link is in the header and still visible with settings expanded.
7. Use a long Thai name.
8. Use Tab/Escape through the disclosure.

Report anything that fails. Do not mark acceptance items done without seeing them.

- [ ] **Step 4: Flip the spec's acceptance checkboxes**

In the spec's "Acceptance and validation" list, change `- [ ]` to `- [x]` only for the items Steps 2–3 actually verified. Leave any unverified item unchecked and say why in its line.

- [ ] **Step 5: Archive**

Only if every acceptance item is checked:

```bash
git mv docs/superpowers/specs/2026-10-13-group-creation-settings-design.md docs/archive/specs/
git mv docs/superpowers/plans/2026-10-13-group-creation-settings.md docs/archive/plans/
```

Otherwise leave both in place.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs PRODUCT.md
git commit -m "docs: group creation and settings routes; close the spec"
```
