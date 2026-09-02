import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';
import { ENV } from './common/constants';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global security headers (CSP, HSTS, X-Content-Type-Options, etc.)
  app.use(helmet());

  // Compress responses (gzip) when the client accepts it.
  app.use(compression());

  // Parse signed/session cookies (HttpOnly access + refresh tokens).
  app.use(cookieParser());

  // Explicit JSON body parsing with a hard size cap.
  app.use(json({ limit: ENV.BODY_LIMIT }));

  // CORS: comma-separated allowlist from env; "*" for open dev access.
  // credentials are required to send/accept the session cookies cross-origin.
  app.enableCors({
    origin: ENV.CORS_ORIGINS,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: !ENV.CORS_ORIGINS.includes('*'),
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(ENV.PORT);
}
void bootstrap();
