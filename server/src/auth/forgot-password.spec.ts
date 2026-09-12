import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AuthModule, SESSION_SECRET } from './auth.module.js';
import { AuthBootstrapService } from './bootstrap.service.js';
import { MAX_ATTEMPTS } from './login-throttle.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';

const SECRET = 'forgot-password-test-secret';
const PASSWORD = 'a genuinely correct password';

describe('POST /auth/forgot', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let email: string;
  let userId: string;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, AuthModule] })
      .overrideProvider(SESSION_SECRET)
      .useValue(SECRET)
      .overrideProvider(AuthBootstrapService)
      .useValue({ onModuleInit: async () => {} })
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser(SECRET));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));

    prisma = app.get(PrismaService);
    email = `forgot-${randomUUID()}@example.test`;
    const user = await app.get(UsersService).create(email, PASSWORD);
    userId = user.id;
  });

  afterEach(async () => {
    await prisma.passwordResetRequest.deleteMany({ where: { email: { contains: 'example.test' } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
  });

  it('reports whether the email matches an account — a deliberate reversal for this app, see the controller comment', async () => {
    const known = await request(server).post('/auth/forgot').send({ email }).expect(201);
    const unknown = await request(server)
      .post('/auth/forgot')
      .send({ email: `nobody-${randomUUID()}@example.test` })
      .expect(201);

    expect(known.body).toEqual({ received: true, exists: true });
    expect(unknown.body).toEqual({ received: true, exists: false });
  });

  it('records the request for a known email', async () => {
    await request(server).post('/auth/forgot').send({ email }).expect(201);
    const rows = await prisma.passwordResetRequest.findMany({ where: { email } });
    expect(rows).toHaveLength(1);
    expect(rows[0].handledAt).toBeNull();
  });

  it('records the request for an unknown email too — the point is not to distinguish', async () => {
    const unknownEmail = `nobody-${randomUUID()}@example.test`;
    await request(server).post('/auth/forgot').send({ email: unknownEmail }).expect(201);
    const rows = await prisma.passwordResetRequest.findMany({ where: { email: unknownEmail } });
    expect(rows).toHaveLength(1);
  });

  it('grants nothing by itself — no token is minted, tokenVersion is untouched', async () => {
    const before = await app.get(UsersService).findById(userId);
    await request(server).post('/auth/forgot').send({ email }).expect(201);
    const after = await app.get(UsersService).findById(userId);

    expect(after!.tokenVersion).toBe(before!.tokenVersion);
    expect(await prisma.passwordReset.count({ where: { userId } })).toBe(0);
  });

  it('rejects a malformed email', async () => {
    await request(server).post('/auth/forgot').send({ email: 'not-an-email' }).expect(400);
  });

  it('throttles repeated requests from one address', async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await request(server)
        .post('/auth/forgot')
        .send({ email: `flood-${i}@example.test` })
        .expect(201);
    }
    await request(server)
      .post('/auth/forgot')
      .send({ email: 'one-more@example.test' })
      .expect(429);

    await prisma.passwordResetRequest.deleteMany({ where: { email: { contains: 'flood-' } } });
  });
});
