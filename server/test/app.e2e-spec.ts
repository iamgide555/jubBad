import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    process.env.ADMIN_TOKEN = 'e2e-test-token';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  it('/ (GET) requires an authenticated admin', async () => {
    const server = app.getHttpServer();
    await request(server).get('/').expect(401);

    const login = await request(server)
      .post('/auth/login')
      .send({ token: 'e2e-test-token' })
      .expect(201);
    const cookie = login.headers['set-cookie']?.[0];
    expect(cookie).toBeDefined();

    await request(server).get('/').set('Cookie', cookie!).expect(200).expect('Hello World!');
  });

  afterEach(async () => {
    await app.close();
  });
});
