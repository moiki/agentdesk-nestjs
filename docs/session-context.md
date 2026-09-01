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
- ✅ **SPC-02 Approval flow** (`openspec/specs/agent-approval/`) — pausa explícita `awaitingApproval`, endpoint `POST /chat/approve` con validación anti-falsificación, rechazo sintético `REJECTED_BY_USER`, partición 3-vía (read-only paralelo / mutantes secuenciales / needsApproval pausa). Docs FE en `docs/spec-02-agent-approval.md`.
- ✅ **Groq provider** (`openspec/specs/groq-provider/`) — `OpenAICompatibleProvider` genérico (chat-completions compatibles), `LLM_PROVIDER=groq`, smoke real `pnpm run test:groq` (pausa→approve→delete contra API Groq). Default `openai/gpt-oss-120b`.
- ✅ **SPC-03 Persistencia server-side de conversaciones** (Opción 3 del plan de acción) — `POST /chat` devuelve `conversationId`; el historial ya NO vive en el cliente. `POST /chat/approve` ahora recibe `{ conversationId, decisions }` (sin `conversationHistory`) y carga el estado canónico desde DB vía `ConversationService`. Modelo Prisma `Conversation` + enum `ConversationStatus` (`ACTIVE|PAUSED|COMPLETED`), migración `20260831225230_add_conversation`. Fix raíz: el `400 Missing decision` por toolCalls huérfanas tras crash del cliente se resuelve con **discard como `REJECTED_BY_USER`** (calls no cubiertas por decisions se tratan como rechazadas/recoverables, no rompen la reanudación). Persistencia tenant-scoped (usa `findFirst` por `id`, no `findUnique`, para evitar el compound-unique de scoping).
- Verificación verde: build ✓ lint ✓ **92 unit** ✓ **41 e2e** ✓ `prisma migrate status` ✓ (migración añadida y aplicada a dev 5433 + test agentdesk_test via global-setup).

## Próximo bloque (roadmap)

1. **Langfuse** — traces + spans + prompt management. EventEmitter2 ya emite `agent.iteration`, `agent.awaiting_approval`, `agent.approval_granted` y `agent.approval_denied`.
2. Decisión abierta: **streaming** del agent loop (SSE o WebSocket).
3. **Model tiering** — routing por complejidad/costo.
4. **Semantic caching** — Redis para respuestas frecuentes.
5. Infra pendiente: ~~`docker compose up` falla en `app` (`pnpm-lock.yaml` no llega al build)~~ **resuelto** — `docker compose build app` + `up -d` OK (healthy). Pendiente aún: `migrate` profile usa la imagen y `.dockerignore` excluye `prisma/migrations/`, así que `migrate deploy` en contenedor no ve migraciones; la migración `add_conversation` se aplicó vía host (`prisma migrate deploy` a 5433).

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
| 22 | `tsx`/esbuild NO sirve para bootstrap de Nest: no emite `design:paramtypes` completo → Nest inyecta `undefined` silenciosamente | Entry points Nest se compilan con `nest build` y corren desde `dist/` (ver `src/scripts/groq-smoke.ts`) |
| 23 | `cross-env VAR=x cmd1 && cmd2` — la env solo aplica a `cmd1`, no a todo el chain | Env al comando que la necesita: `"a && cross-env VAR=x b"` |
| 24 | Catálogo Groq cambia: `llama-3.3-70b-versatile` deprecado (2026) → 400 model_not_found | Default `openai/gpt-oss-120b`; ante model_not_found, listar `/openai/v1/models` con la key |
| 25 | ts-node CJS no resuelve los imports `.js` del cliente Prisma generado (solo jest lo mapea) | Otra razón para compilar scripts standalone a dist (gotcha 22) |
| 26 | Validación anti-falsificación del approve: pending ≠ "último mensaje assistant" | Detección = toolCalls SIN responder (ids sin mensaje `role:'tool'` correspondiente); necesario para batches mixtos donde resultados seguros siguen al assistant |
| 27 | `coverage/` estaba trackeada en git — ensuciaba cada diff | Des-indexada + `.gitignore`; si reaparece en diff, es working tree local |
| 28 | Scoping tenant autorizaría un `findUnique` compound-unique en `Conversation` y romper el lookup por id | `Conversation` usa `@id` plano y `findFirst({ where: { id } })` — la extensión inyecta `tenantId`, lo que da lookups enfocados al tenant (fails closed cross-tenant) |

Decisiones de arquitectura: la identidad del tenant sale **solo del JWT**; el modelo `Tenant` es admin (exento de scoping); `TenantScopedPrismaService` es el único camino para dominio de tenant; auth = middleware único como enforcement point (no guard, por orden middleware→guards en NestJS); signup usa transacción + `tenantContextStore.run` envolviendo el `$transaction`. El agent loop es **stateful server-side**: `AgentService.chat()` persiste la conversación (`ConversationService`) y `approve()` carga el estado canónico desde DB; el cliente solo guarda y reenvía el `conversationId`. `ToolRegistry` es central y extensible (registrar nuevos tools = implementar `Tool` y `register()`). Los tools se declaran con `mutating: true/false` para paralelismo y `requiresApproval: true/false` para aprobación humana. `EventEmitter2` emite eventos por iteración para Langfuse futuro.

## Modelos y ambiente

- Postgres en puerto **5433** (dev `agentdesk`, test `agentdesk_test`, shadow `agentdesk_shadow`); Redis 6379; Docker.
- Prisma 7 con generator `prisma-client` CJS → cliente en `src/generated/prisma` (gitignoreado); `prisma.config.ts` importa `ENV` desde `src/common/constants`.
- `test/setup-env.ts` fuerza `LLM_PROVIDER=fake`, `JWT_SECRET=test-secret`, throttle alto y `DATABASE_URL`→test.
- e2e: `node --experimental-vm-modules` + config `test/jest-e2e.json` (moduleNameMapper, `maxWorkers: 1`).
- GitHub Models está **retirado** (jul-2026); para probar flujos de agente: fake cassettes (primario), Groq real (`pnpm run test:groq`, requiere `GROQ_API_KEY`) o Anthropic real.
- Guía para consumidores del backend (FE): **`docs/integration-guide.md`** — contrato completo de endpoints, chat con persistencia server-side (`conversationId`) y approval flow.

## Comandos de verificación

```bash
pnpm run build && pnpm run lint && pnpm test && pnpm run test:e2e
npx prisma migrate status   # valida prisma.config.ts tras cambios de env
```

## Cómo verificar modelos de IA / costos

- Modelo usado: **opencode/big-pickle** (alias interno). Costo/billing lo lleva el proveedor de opencode (dashboard), no el agente.

## Archivos relevantes

- `src/agent/` — `agent.module.ts` (EventEmitterModule + LlmModule + TicketsModule + TenancyModule), `agent.service.ts` (orchestrator loop con retry, budget compuesto, paralelización, `runLoop()`, approval flow + `approve()`), `conversation.service.ts` (persistencia server-side tenant-scoped: `create`/`updateMessages`/`setStatus`/`toMessages`), `chat.controller.ts` (`POST /chat`, `POST /chat/approve`), `dto/chat.dto.ts` (añade `conversationId`), `dto/approve-chat.dto.ts` (ahora `{ conversationId, decisions }`, `conversationHistory` eliminado).
- `src/agent/tools/` — `tool.interface.ts` (Tool + ToolResult + ToolErrorCode con `REJECTED_BY_USER`), `tool-registry.service.ts` (register, getDefinitions, getTool, execute con truncado y safeParse), `ticket-tools.ts` (5 tools CRUD, mutating + requiresApproval flags).
- `src/health/health.controller.ts` — `GET /health` con check de DB connectivity (usado por Docker healthcheck).
- `src/llm/` — `llm-provider.interface.ts`, `llm.types.ts` (LlmStopReason incluye `max_iterations`), `tool-schema.ts`, `fake-llm.provider.ts` (cassettes + `clear()`), `anthropic-llm.provider.ts`, `openai-compatible.provider.ts` (Groq/OpenAI/compatibles; modelo del provider autoritativo), `llm.module.ts` (`createLlmProvider()` exportada: fake | anthropic | groq).
- `src/scripts/groq-smoke.ts` — smoke real contra Groq (compilado a `dist/scripts/`, NUNCA corre en Jest/CI).
- `src/auth/` — `auth-context.middleware.ts`, `auth.module.ts`, `auth.service.ts`, `auth.controller.ts`, `auth.types.ts`, `dto/login.dto.ts`.
- `src/signup/` — dto, service (transacción + P2002→409), controller, module.
- `src/tenancy/` — `tenant-context.ts` (ALS), `tenant-scoped.prisma.ts` (extensión scoping), `tenant-scoped-prisma.service.ts`.
- `src/common/constants.ts` — **única fuente de envs** (incluye `AGENT_MAX_ITERATIONS`, `AGENT_MAX_TOTAL_TOKENS`, `AGENT_MAX_WALL_CLOCK_MS`, `AGENT_SYSTEM_PROMPT`, `AGENT_LLM_MAX_RETRIES`).
- `Dockerfile` — multi-stage: `deps` (pnpm install) → `build` (prisma generate + nest build) → `production` (minimal image, non-root, healthcheck).
- `docker-compose.yml` — services: `postgres`, `redis`, `app` (production), `migrate` (profile: tools).
- `.dockerignore` — excluye node_modules, dist, .env, tests, docs, migrations.
- `src/prisma/prisma.service.ts` — cliente raw (plataforma, unscoped).
- `docs/uc-01-tenant-signup.md`, `docs/spec-01-tenant-signup-auth.md`, `docs/spec-02-agent-approval.md`, `docs/integration-guide.md` — specs y guía de consumo.
- `openspec/specs/{agent-approval,groq-provider}/spec.md` — source of truth SDD (changes archivados en `openspec/changes/archive/`).
- Tests: `test/auth.e2e-spec.ts`, `test/tenant-isolation.e2e-spec.ts`, `test/app.e2e-spec.ts`, `test/llm-provider.e2e-spec.ts`, `test/agent.e2e-spec.ts`, `test/agent-approval.e2e-spec.ts` (8 tests: pausa, approve/reject, falsificación, pipe, cross-tenant, re-pausa encadenada, args Zod inválidos), `test/utils.ts` (helpers `createTestApp`, `signupAndAuth`, `asUser`).
