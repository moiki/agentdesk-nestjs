import 'dotenv/config';

/**
 * Centralized environment variable management.
 *
 * Single source of truth for every env var the app reads: names, defaults and
 * parsing all live here instead of scattered `process.env.X` calls.
 *
 * Read once at import time, AFTER dotenv has populated process.env. Tests set
 * their overrides in test/setup-env.ts before any app module is imported, so
 * this module always sees the final values.
 */
export const ENV = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: Number(process.env.PORT ?? 3000),

  DATABASE_URL: process.env.DATABASE_URL,
  SHADOW_DATABASE_URL: process.env.SHADOW_DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',

  JWT_SECRET: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  JWT_SECRET_SET: process.env.JWT_SECRET !== undefined,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? '1h',

  THROTTLE_TTL_MS: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
  THROTTLE_LIMIT: Number(process.env.THROTTLE_LIMIT ?? 100),

  ALLOW_TENANT_HEADER: process.env.ALLOW_TENANT_HEADER === 'true',

  CORS_ORIGINS: (process.env.CORS_ORIGINS ?? '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  BODY_LIMIT: process.env.BODY_LIMIT ?? '100kb',

  LLM_PROVIDER: process.env.LLM_PROVIDER ?? 'fake',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
  LLM_MODEL: process.env.LLM_MODEL ?? 'claude-3-5-haiku-latest',

  GROQ_API_KEY: process.env.GROQ_API_KEY ?? '',
  GROQ_BASE_URL: process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
  GROQ_MODEL: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b',

  AGENT_MAX_ITERATIONS: Number(process.env.AGENT_MAX_ITERATIONS ?? 10),
  AGENT_MAX_TOTAL_TOKENS: Number(process.env.AGENT_MAX_TOTAL_TOKENS ?? 200_000),
  AGENT_MAX_WALL_CLOCK_MS: Number(
    process.env.AGENT_MAX_WALL_CLOCK_MS ?? 120_000,
  ),
  AGENT_SYSTEM_PROMPT: process.env.AGENT_SYSTEM_PROMPT ?? '',
  AGENT_LLM_MAX_RETRIES: Number(process.env.AGENT_LLM_MAX_RETRIES ?? 3),
} as const;
