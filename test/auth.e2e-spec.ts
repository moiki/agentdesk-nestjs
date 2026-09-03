import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { asUser, createTestApp, signupAndAuth } from './utils';

describe('Auth flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let httpServer: App;

  beforeAll(async () => {
    app = await createTestApp();
    httpServer = app.getHttpServer();
    prisma = app.get(PrismaService);

    await prisma.ticket.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.tenant.deleteMany({});
  });

  afterAll(async () => {
    await prisma.ticket.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.tenant.deleteMany({});
    await app.close();
  });

  it('rejects a signup with a duplicate email', async () => {
    await signupAndAuth(httpServer, {
      email: 'dup@auth.test',
      workspaceName: 'dup-email',
    });

    await request(httpServer)
      .post('/signup')
      .send({
        companyName: 'Other Corp',
        workspaceName: 'dup-email-2',
        adminEmail: 'dup@auth.test',
        adminPassword: 'password123',
      })
      .expect(409);
  });

  it('rejects a signup with a duplicate workspace slug', async () => {
    await signupAndAuth(httpServer, {
      email: 'a@auth.test',
      workspaceName: 'dup-slug',
    });

    await request(httpServer)
      .post('/signup')
      .send({
        companyName: 'Other Corp',
        workspaceName: 'dup-slug',
        adminEmail: 'b@auth.test',
        adminPassword: 'password123',
      })
      .expect(409);
  });

  it('does not leave partial state when signup fails on a unique constraint', async () => {
    await signupAndAuth(httpServer, {
      email: 'partial@auth.test',
      workspaceName: 'partial-base',
    });

    const before = await prisma.tenant.count();
    await request(httpServer)
      .post('/signup')
      .send({
        companyName: 'Ghost Corp',
        workspaceName: 'ghost-workspace',
        adminEmail: 'partial@auth.test',
        adminPassword: 'password123',
      })
      .expect(409);
    const after = await prisma.tenant.count();
    expect(after).toBe(before);
  });

  it('rejects plans other than FREE at signup', async () => {
    await request(httpServer)
      .post('/signup')
      .send({
        companyName: 'Paid Corp',
        workspaceName: 'paid-plan',
        adminEmail: 'paid@auth.test',
        adminPassword: 'password123',
        plan: 'PRO',
      })
      .expect(400);
  });

  it('logs in with correct credentials and returns an access token', async () => {
    await signupAndAuth(httpServer, {
      email: 'login@auth.test',
      workspaceName: 'login-flow',
    });

    const res = await request(httpServer)
      .post('/auth/login')
      .send({ email: 'login@auth.test', password: 'password123' })
      .expect(200);

    expect(res.body.accessToken).toBeDefined();
    expect(typeof res.body.accessToken).toBe('string');
  });

  it('rejects a wrong password with 401', async () => {
    await request(httpServer)
      .post('/auth/login')
      .send({ email: 'login@auth.test', password: 'wrong-password' })
      .expect(401);
  });

  it('rejects an unknown user with 401 (no user enumeration)', async () => {
    await request(httpServer)
      .post('/auth/login')
      .send({ email: 'nobody@auth.test', password: 'password123' })
      .expect(401);
  });

  it('returns the profile via /auth/me using only the token', async () => {
    const t = await signupAndAuth(httpServer, {
      companyName: 'Me Corp',
      workspaceName: 'me-profile',
      email: 'me@auth.test',
    });

    const res = await request(httpServer)
      .get('/auth/me')
      .set(asUser(t.accessToken))
      .expect(200);

    expect(res.body.tenantId).toBe(t.tenantId);
    expect(res.body.userId).toBe(t.adminUserId);
    expect(res.body.role).toBe('ADMIN');
    expect(res.body.plan).toBe('FREE');
    expect(res.body.tenantName).toBe('Me Corp');
  });

  it('never exposes the password hash (API and DB)', async () => {
    const t = await signupAndAuth(httpServer, {
      email: 'safe@auth.test',
      workspaceName: 'safe-hash',
    });

    const me = await request(httpServer)
      .get('/auth/me')
      .set(asUser(t.accessToken))
      .expect(200);

    expect(JSON.stringify(me.body)).not.toContain('passwordHash');

    const user = await prisma.user.findUnique({
      where: { email: 'safe@auth.test' },
    });
    expect(user?.passwordHash).toBeDefined();
    expect(user?.passwordHash).not.toBe('password123');
  });

  it('sets HttpOnly session cookies on login', async () => {
    await signupAndAuth(httpServer, {
      email: 'cookies@auth.test',
      workspaceName: 'cookie-login',
    });

    const res = await request(httpServer)
      .post('/auth/login')
      .send({ email: 'cookies@auth.test', password: 'password123' })
      .expect(200);

    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const joined = setCookie.join('; ');
    expect(joined).toContain('access_token=');
    expect(joined).toContain('refresh_token=');
    expect(joined).toContain('HttpOnly');
  });

  it('keeps the session authenticated via cookies (no bearer header)', async () => {
    const email = 'cookie-session@auth.test';
    const workspaceName = 'cookie-session';
    await signupAndAuth(httpServer, { email, workspaceName });

    const agent = request.agent(httpServer);
    await agent
      .post('/auth/login')
      .send({ email, password: 'password123' })
      .expect(200);

    const me = await agent.get('/auth/me').expect(200);
    expect(me.body.email).toBe(email);
    expect(me.body.role).toBe('ADMIN');
  });

  it('rotates the refresh token on /auth/refresh and persists session across reloads', async () => {
    const email = 'rotating@auth.test';
    const workspaceName = 'rotating';
    await signupAndAuth(httpServer, { email, workspaceName });

    const agent = request.agent(httpServer);
    await agent
      .post('/auth/login')
      .send({ email, password: 'password123' })
      .expect(200);

    const refreshRes = await agent.post('/auth/refresh').expect(200);
    expect(refreshRes.body.accessToken).toBeDefined();

    const me = await agent.get('/auth/me').expect(200);
    expect(me.body.email).toBe(email);
  });

  it('logs out by invalidating the refresh token', async () => {
    const email = 'logout@auth.test';
    const workspaceName = 'logout-flow';
    await signupAndAuth(httpServer, { email, workspaceName });

    const res = await request(httpServer)
      .post('/auth/login')
      .send({ email, password: 'password123' })
      .expect(200);

    const setCookie = res.headers['set-cookie'] as unknown as string[];

    await request(httpServer)
      .post('/auth/logout')
      .set('Cookie', setCookie)
      .expect(200);

    const remaining = await prisma.refreshToken.findMany({
      where: { user: { email } },
    });
    expect(remaining.length).toBe(0);
  });
});
