import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { SESSION_SECRET } from './../src/auth/auth.module.js';
import { AuthBootstrapService } from './../src/auth/bootstrap.service.js';
import { UsersService } from './../src/users/users.service.js';

const SECRET = 'e2e-test-session-secret';
const EMAIL = 'e2e-test@example.test';
const PASSWORD = 'a genuinely correct e2e password';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SESSION_SECRET)
      .useValue(SECRET)
      // No server/.env in a fresh clone or CI — this test seeds its own user.
      .overrideProvider(AuthBootstrapService)
      .useValue({ onModuleInit: async () => {} })
      .compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser(SECRET));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await app.get(UsersService).create(EMAIL, PASSWORD);
  });

  it('/ (GET) requires an authenticated user', async () => {
    const server = app.getHttpServer();
    await request(server).get('/').expect(401);

    const login = await request(server)
      .post('/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(201);
    const cookie = login.headers['set-cookie']?.[0];
    expect(cookie).toBeDefined();

    await request(server).get('/').set('Cookie', cookie!).expect(200).expect('Hello World!');
  });

  afterEach(async () => {
    await app.close();
  });
});
