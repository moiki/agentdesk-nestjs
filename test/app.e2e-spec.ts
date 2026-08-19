import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils';

describe('AgentDesk API smoke (e2e)', () => {
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

  it('exposes a health endpoint without auth', async () => {
    const res = await request(httpServer).get('/health').expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('connected');
    expect(res.body.timestamp).toBeDefined();
  });

  it('signs a tenant up through the public self-service endpoint', async () => {
    const res = await request(httpServer)
      .post('/signup')
      .send({
        companyName: 'Acme Corp',
        workspaceName: 'acme-corp',
        adminEmail: 'admin@acme-corp.test',
        adminPassword: 'password123',
      })
      .expect(201);

    expect(res.body.tenantId).toBeDefined();
    expect(res.body.adminUserId).toBeDefined();
    expect(res.body.plan).toBe('FREE');
  });

  it('protects tenant-scoped routes without a token', async () => {
    await request(httpServer).get('/tickets').expect(401);
  });

  it('validates the signup body (whitelist)', async () => {
    await request(httpServer)
      .post('/signup')
      .send({
        companyName: 'Acme Corp',
        workspaceName: 'ACME_CORP',
        adminEmail: 'admin@acme-corp.test',
        adminPassword: 'password123',
      })
      .expect(400);
  });
});
