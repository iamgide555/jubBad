// Loads server/.env for local runs (`nest start`), matching how
// prisma7.config.ts and vitest.config.ts already get DATABASE_URL. In Docker
// there is no .env file and the vars come from compose's env_file, where this
// is a no-op — dotenv never overrides an env var that is already set.
import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import { parseCorsOrigins } from './cors.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: parseCorsOrigins(process.env.CORS_ORIGINS),
    /**
     * The admin cookie only rides along on cross-origin requests if both ends
     * opt in. Production is same-origin through nginx so this changes nothing
     * there; it is what lets a cross-origin dev setup work if anyone runs one
     * without the proxy.
     */
    credentials: true,
  });
  // Must precede the guard, which reads req.cookies.
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
