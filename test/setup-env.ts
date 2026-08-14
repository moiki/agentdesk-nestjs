import 'dotenv/config';

// Run in every jest worker before any test module is imported, so the Nest
// app boots against the dedicated test database instead of the dev one.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// Tests never talk to a real LLM.
process.env.LLM_PROVIDER = 'fake';

// Deterministic JWT secret + generous rate limit so suites never throttle.
process.env.JWT_SECRET = 'test-secret';
process.env.THROTTLE_LIMIT = '10000';
process.env.THROTTLE_TTL_MS = '60000';
