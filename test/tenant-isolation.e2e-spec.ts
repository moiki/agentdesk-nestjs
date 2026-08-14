import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { asUser, createTestApp, signupAndAuth } from './utils';

describe('Tenant isolation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let httpServer: App;

  let tenantA: { tenantId: string; accessToken: string };
  let tenantB: { tenantId: string; accessToken: string };

  beforeAll(async () => {
    app = await createTestApp();
    httpServer = app.getHttpServer();
    prisma = app.get(PrismaService);

    await prisma.ticket.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.tenant.deleteMany({});

    tenantA = await signupAndAuth(httpServer, {
      companyName: 'Tenant A',
      workspaceName: 'tenant-a',
      email: 'a@isolation.test',
    });
    tenantB = await signupAndAuth(httpServer, {
      companyName: 'Tenant B',
      workspaceName: 'tenant-b',
      email: 'b@isolation.test',
    });
  });

  afterAll(async () => {
    await prisma.ticket.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.tenant.deleteMany({});
    await app.close();
  });

  it('requires a bearer token on tenant-scoped routes', async () => {
    await request(httpServer).get('/tickets').expect(401);
  });

  it('rejects an invalid token', async () => {
    await request(httpServer)
      .get('/tickets')
      .set(asUser('not-a-jwt'))
      .expect(401);
  });

  it('rejects a spoofed tenantId in the request body', async () => {
    await request(httpServer)
      .post('/tickets')
      .set(asUser(tenantA.accessToken))
      .send({ title: 'spoofed', tenantId: tenantB.tenantId })
      .expect(400);
  });

  describe('cross-tenant isolation', () => {
    let ticketA1: string;
    let ticketA2: string;
    let ticketB1: string;

    beforeAll(async () => {
      const a1 = await request(httpServer)
        .post('/tickets')
        .set(asUser(tenantA.accessToken))
        .send({ title: 'A - ticket 1' })
        .expect(201);
      const a2 = await request(httpServer)
        .post('/tickets')
        .set(asUser(tenantA.accessToken))
        .send({ title: 'A - ticket 2' })
        .expect(201);
      const b1 = await request(httpServer)
        .post('/tickets')
        .set(asUser(tenantB.accessToken))
        .send({ title: 'B - ticket 1' })
        .expect(201);

      ticketA1 = a1.body.id;
      ticketA2 = a2.body.id;
      ticketB1 = b1.body.id;
    });

    it('stores the ticket under the token tenant, not the body', async () => {
      const rows = await prisma.ticket.findMany({ where: { id: ticketB1 } });
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe(tenantB.tenantId);
    });

    it('tenant A lists only its own tickets', async () => {
      const res = await request(httpServer)
        .get('/tickets')
        .set(asUser(tenantA.accessToken))
        .expect(200);
      const titles = res.body.map((t: any) => t.title);
      expect(titles).toEqual(
        expect.arrayContaining(['A - ticket 1', 'A - ticket 2']),
      );
      expect(titles).not.toContain('B - ticket 1');
    });

    it('tenant B lists only its own tickets', async () => {
      const res = await request(httpServer)
        .get('/tickets')
        .set(asUser(tenantB.accessToken))
        .expect(200);
      const titles = res.body.map((t: any) => t.title);
      expect(titles).toEqual(['B - ticket 1']);
    });

    it('tenant B cannot read tenant A ticket by id — 404, not 200 (no existence leak)', async () => {
      await request(httpServer)
        .get(`/tickets/${ticketA1}`)
        .set(asUser(tenantB.accessToken))
        .expect(404);
    });

    it('tenant A can read its own ticket by id', async () => {
      await request(httpServer)
        .get(`/tickets/${ticketA1}`)
        .set(asUser(tenantA.accessToken))
        .expect(200);
    });

    it('tenant B cannot update tenant A ticket — 404', async () => {
      await request(httpServer)
        .patch(`/tickets/${ticketA1}`)
        .set(asUser(tenantB.accessToken))
        .send({ status: 'CLOSED' })
        .expect(404);
    });

    it('tenant B cannot delete tenant A ticket — 404', async () => {
      await request(httpServer)
        .delete(`/tickets/${ticketA1}`)
        .set(asUser(tenantB.accessToken))
        .expect(404);
    });

    it('tenant A can still access its tickets after B attempted access', async () => {
      const res = await request(httpServer)
        .get(`/tickets/${ticketA2}`)
        .set(asUser(tenantA.accessToken))
        .expect(200);
      expect(res.body.title).toBe('A - ticket 2');
    });
  });
});
