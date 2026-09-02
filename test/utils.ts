import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();
  return app;
}

let signupCounter = 0;

export interface SignedUpTenant {
  tenantId: string;
  adminUserId: string;
  accessToken: string;
  email: string;
  workspaceName: string;
}

/**
 * Self-service onboarding helper: signs a tenant up and logs the admin in,
 * returning the ids and the bearer token used by the rest of the suite.
 */
export async function signupAndAuth(
  httpServer: App,
  overrides: {
    companyName?: string;
    workspaceName?: string;
    email?: string;
    password?: string;
  } = {},
): Promise<SignedUpTenant> {
  signupCounter += 1;
  const email = overrides.email ?? `tenant${signupCounter}@test.local`;
  const workspaceName = overrides.workspaceName ?? `tenant-${signupCounter}`;
  const companyName = overrides.companyName ?? `Tenant ${signupCounter}`;
  const password = overrides.password ?? 'password123';

  const signup = await request(httpServer)
    .post('/signup')
    .send({
      companyName,
      workspaceName,
      adminEmail: email,
      adminPassword: password,
    })
    .expect(201);

  const login = await request(httpServer)
    .post('/auth/login')
    .send({ email, password })
    .expect(200);

  return {
    tenantId: signup.body.tenantId,
    adminUserId: signup.body.adminUserId,
    accessToken: login.body.accessToken,
    email,
    workspaceName,
  };
}

/** Auth header helper for supertest requests. */
export const asUser = (accessToken: string) => ({
  Authorization: `Bearer ${accessToken}`,
});
