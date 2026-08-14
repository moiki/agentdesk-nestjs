import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';

/**
 * Jest globalSetup for the e2e suite:
 *  1. Ensures the dedicated test database exists.
 *  2. Applies pending Prisma migrations to it (idempotent).
 */
export default async function globalSetup(): Promise<void> {
  const testDbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!testDbUrl) {
    throw new Error('TEST_DATABASE_URL is not set');
  }

  const url = new URL(testDbUrl);
  const dbName = url.pathname.slice(1);

  const admin = new Client({
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: 'postgres',
  });

  await admin.connect();
  const { rowCount } = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [dbName],
  );
  if (!rowCount) {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  }
  await admin.end();

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: testDbUrl },
    stdio: 'inherit',
  });
}
