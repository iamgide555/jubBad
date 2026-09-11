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
import { SESSION_SECRET } from './auth/auth.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  /**
   * Production traffic reaches the API through exactly one trusted nginx hop.
   * nginx overwrites X-Forwarded-For with Cloudflare's client address, so
   * Express can use that address for login throttling without accepting a
   * spoofed header from an arbitrary client.
   */
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
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
  /**
   * Must precede the guard, which reads req.signedCookies. Resolved through
   * the app rather than read from process.env a second time, so this can
   * never drift from the value AuthModule's SESSION_SECRET provider actually
   * validated — an unsecreted cookieParser() here would silently fail every
   * signed-cookie read rather than throw, which is the one failure mode this
   * duplication exists to rule out.
   */
  app.use(cookieParser(app.get(SESSION_SECRET)));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
