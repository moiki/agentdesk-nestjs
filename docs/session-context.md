# Session Context — AgentDesk

Contexto de trabajo para retomar la sesión sin perder nada. Se actualiza al cierre de cada sesión.

## Propósito del proyecto

**AgentDesk**: gateway agéntico multi-tenant en NestJS 11. Cada tenant tiene su propio agente de IA con tool calling, datos aislados a nivel de fila (row-level isolation) y observabilidad preparada. Un frontend/cliente habla con el agente vía API; el agente ejecuta tools reales (tickets, ...) dentro del contexto del tenant correcto.

## Estado actual (última sesión)

- ✅ Fase 1 — Base + scaffolding multi-tenant (aislamiento primero).
- ✅ Fase 2 — LLM provider abstraction (interfaz + fake cassette + Anthropic).
- ✅ SPC-01 — Signup self-service (`POST /signup`) + auth JWT (`POST /auth/login`, `GET /auth/me`). Retirado `src/tenants/` y el header `x-tenant-id` como fuente de confianza.
- ✅ Env centralizado en `src/common/constants.ts` (objeto `ENV`); desinstalado `@nestjs/config`.
- ✅ Seguridad HTTP en `main.ts`: helmet, compression, `json({limit})`, CORS por env.
- ✅ **Tool registry + Agent loop** — `POST /chat` con loop agéntico, 5 tools de tickets, maxIterations guard.
- ✅ **Agent loop v2** — 10 mejoras de Claude aplicadas: stopReason propio, retry con backoff, errores estructurados, paralelización de tools read-only, truncado de resultados grandes, budget compuesto (tokens+tiempo), idempotencia, requiresApproval, EventEmitter hook.
- ✅ **pnpm migration** — package-lock.json eliminado, pnpm-lock.yaml generado, `packageManager` field en package.json.
- ✅ **Docker formal** — Dockerfile multi-stage (deps→build→production), .dockerignore, docker-compose.yml con app + migrate profile, health check con DB connectivity.
- Verificación verde: build ✓ lint ✓ 71 unit ✓ 33 e2e ✓ `prisma migrate status` ✓.

## Próximo bloque (roadmap)

1. **OpenAI-compatible LLM provider** — Provider genérico que cubra Groq, Together.ai, DeepSeek, Ollama. Instalar `openai` SDK, crear `OpenAICompatibleProvider`, agregar `GROQ_API_KEY` a env vars. Groq gratis: ~30 req/min, llama-3.3-70b.
2. **Langfuse** — traces + spans + prompt management. EventEmitter2 ya instalado y emitiendo `agent.iteration` y `agent.awaiting_approval`.
3. Decisión abierta: **streaming** del agent loop (SSE o WebSocket).
4. **Model tiering** — routing por complejidad/costo.
5. **Semantic caching** — Redis para respuestas frecuentes.

## Decisiones y gotchas (no volver a pisarlas)

| # | Gotcha | Solución |
|---|---|---|
| 1 | Express 5 + `forRoutes('*')`: `req.path` es relativo al mount (`"/"`) | Matchear rutas públicas con `req.originalUrl` (ver `AuthContextMiddleware`) |
| 2 | Prisma `$transaction` interactivo: el contexto ALS NO se ve en los hooks si `tenantContextStore.run()` va dentro del callback | `run()` debe envolver el `$transaction` COMPLETO |
| 3 | `prisma migrate dev` es interactivo (falla sin TTY) | Migración manual: `prisma migrate diff --from-migrations ... --to-schema prisma/schema.prisma --script` + `migrate deploy` + `generate` |
| 4 | Cliente Prisma generado (ESM, imports `.js`) rompía jest unit | `moduleNameMapper` `^(\\.{1,2}/.*)\\.js$ → $1` en `package.json` (ya el config e2e lo tenía) |
| 5 | `zod-to-json-schema@3.25` roto con zod 4.4 (output `{}`) | Usar `z.toJSONSchema()` nativo de zod 4 |
| 6 | `compression` sin tipos | `@types/compression` devDep |
| 7 | El `Body` del signup que pasa por `$transaction` necesita `tenantId` explícito en data (para TS) aunque la extensión lo sobreescriba | — |
| 8 | `FakeLlmProvider` cassette matching: `find()` retorna primer match — cassettes genéricos (`match: {}`) bloquean los específicos | Usar matchers específicos (`hasToolCalls`, `includesText`, `toolName`) y `clear()` entre tests |
| 9 | `TicketsModule` no exportaba `TicketsService` — `AgentModule` no podía inyectarlo en `TicketTools` | Agregar `exports: [TicketsService]` a `TicketsModule` |
| 10 | Zod v4 UUID validation rechaza `00000000-0000-0000-0000-000000000001` | Usar UUIDs válidos en tests (`550e8400-e29b-41d4-a716-446655440000`) |
| 11 | `stopReason: 'max_tokens'` se usaba para max iteraciones — confundía con "modelo sin tokens" | Agregar `'max_iterations'` a `LlmStopReason` y usarlo al cortar por iteraciones |
| 12 | `llm.complete()` sin retry — rate limit 429 o timeout de red revienta el request completo | `callLlmWithRetry()` con exponential backoff, configurable via `AGENT_LLM_MAX_RETRIES` (default 3) |
| 13 | Tool errors como string plano — el LLM no puede distinguir `NOT_FOUND` de `INTERNAL_ERROR` | Errores estructurados `{ code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR', message }`. System prompt enseña al modelo a distinguirlos |
| 14 | Tool calls secuenciales aunque sean read-only — latencia innecesaria | `Promise.allSettled()` para tools sin `mutating`, secuencial para los demás |
| 15 | `JSON.stringify(result.data)` sin truncar — historial crece sin límite en conversaciones stateless | `MAX_RESULT_CHARS = 4000` en `ToolRegistry`, trunca strings y objetos serializados |
| 16 | Budget solo de iteraciones — un loop con payloads grandes puede quemar tokens sin llegar al límite | `LoopBudget`: `maxIterations` (10) + `maxTotalTokens` (200k) + `maxWallClockMs` (120s) |
| 17 | Tools mutantes sin idempotencia — retry duplica tickets | `mutating: true` en tools de escritura, `toolCallId` propagado como clave de idempotencia |
| 18 | `delete_ticket` ejecuta automáticamente igual que `list_tickets` — riesgo para tools sensibles | `requiresApproval: true` en tools destructivos, loop pausa y devuelve estado `awaiting_approval` |
| 19 | `FakeLlmProvider` sin `clear()` — estado persiste entre tests e2e | `clear()` resetea cassettes y requests array |
| 20 | `node ./node_modules/.bin/jest` falla con pnpm — `.bin/jest` es shell script, no JS | Usar `NODE_OPTIONS='--experimental-vm-modules' jest` en scripts |
| 21 | Health check test esperaba `{ status: 'ok' }` pero controlador ahora retorna `{ status, db, timestamp }` | Test debe asserts individuales, no body completo |

Decisiones de arquitectura: la identidad del tenant sale **solo del JWT**; el modelo `Tenant` es admin (exento de scoping); `TenantScopedPrismaService` es el único camino para dominio de tenant; auth = middleware único como enforcement point (no guard, por orden middleware→guards en NestJS); signup usa transacción + `tenantContextStore.run` envolviendo el `$transaction`. El agent loop es **stateless** (el cliente maneja el historial). `ToolRegistry` es central y extensible (registrar nuevos tools = implementar `Tool` y `register()`). Los tools se declaran con `mutating: true/false` para paralelismo y `requiresApproval: true/false` para aprobación humana. `EventEmitter2` emite eventos por iteración para Langfuse futuro.

## Modelos y ambiente

- Postgres en puerto **5433** (dev `agentdesk`, test `agentdesk_test`, shadow `agentdesk_shadow`); Redis 6379; Docker.
- Prisma 7 con generator `prisma-client` CJS → cliente en `src/generated/prisma` (gitignoreado); `prisma.config.ts` importa `ENV` desde `src/common/constants`.
- `test/setup-env.ts` fuerza `LLM_PROVIDER=fake`, `JWT_SECRET=test-secret`, throttle alto y `DATABASE_URL`→test.
- e2e: `node --experimental-vm-modules` + config `test/jest-e2e.json` (moduleNameMapper, `maxWorkers: 1`).
- GitHub Models está **retirado** (jul-2026); para probar flujos de agente: fake cassettes (primario) o Anthropic real.

## Comandos de verificación

```bash
pnpm run build && pnpm run lint && pnpm test && pnpm run test:e2e
npx prisma migrate status   # valida prisma.config.ts tras cambios de env
```

## Cómo verificar modelos de IA / costos

- Modelo usado: **opencode/big-pickle** (alias interno). Costo/billing lo lleva el proveedor de opencode (dashboard), no el agente.

## Archivos relevantes

- `src/agent/` — `agent.module.ts` (EventEmitterModule + LlmModule + TicketsModule + TenancyModule), `agent.service.ts` (orchestrator loop con retry, budget compuesto, paralelización, approval flow), `chat.controller.ts` (`POST /chat`), `dto/chat.dto.ts`.
- `src/agent/tools/` — `tool.interface.ts` (Tool + ToolResult + ToolErrorCode), `tool-registry.service.ts` (register, getDefinitions, getTool, execute con truncado), `ticket-tools.ts` (5 tools CRUD, mutating + requiresApproval flags).
- `src/health/health.controller.ts` — `GET /health` con check de DB connectivity (usado por Docker healthcheck).
- `src/llm/` — `llm-provider.interface.ts`, `llm.types.ts` (LlmStopReason incluye `max_iterations`), `tool-schema.ts`, `fake-llm.provider.ts` (cassettes + `clear()`), `anthropic-llm.provider.ts`, `llm.module.ts`.
- `src/auth/` — `auth-context.middleware.ts`, `auth.module.ts`, `auth.service.ts`, `auth.controller.ts`, `auth.types.ts`, `dto/login.dto.ts`.
- `src/signup/` — dto, service (transacción + P2002→409), controller, module.
- `src/tenancy/` — `tenant-context.ts` (ALS), `tenant-scoped.prisma.ts` (extensión scoping), `tenant-scoped-prisma.service.ts`.
- `src/common/constants.ts` — **única fuente de envs** (incluye `AGENT_MAX_ITERATIONS`, `AGENT_MAX_TOTAL_TOKENS`, `AGENT_MAX_WALL_CLOCK_MS`, `AGENT_SYSTEM_PROMPT`, `AGENT_LLM_MAX_RETRIES`).
- `Dockerfile` — multi-stage: `deps` (pnpm install) → `build` (prisma generate + nest build) → `production` (minimal image, non-root, healthcheck).
- `docker-compose.yml` — services: `postgres`, `redis`, `app` (production), `migrate` (profile: tools).
- `.dockerignore` — excluye node_modules, dist, .env, tests, docs, migrations.
- `src/prisma/prisma.service.ts` — cliente raw (plataforma, unscoped).
- `docs/uc-01-tenant-signup.md`, `docs/spec-01-tenant-signup-auth.md` — specs implementadas.
- Tests: `test/auth.e2e-spec.ts`, `test/tenant-isolation.e2e-spec.ts`, `test/app.e2e-spec.ts`, `test/llm-provider.e2e-spec.ts`, `test/agent.e2e-spec.ts`, `test/utils.ts` (helpers `createTestApp`, `signupAndAuth`, `asUser`).
