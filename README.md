# AgentDesk — Agentic AI Gateway multi-tenant en NestJS

Backend NestJS que actúa como gateway de agentes de IA para múltiples clientes (tenants): cada tenant tiene su propio agente con tool calling, datos completamente aislados, y todo trazado para observabilidad.

## Estado actual — SPC-01 (signup self-service + auth JWT)

Multi-tenant scaffolding (Fase 1) + capa de LLM intercambiable (Fase 2) + onboarding y autenticación:

- **Tenancy**: contexto de tenant propagado vía `AsyncLocalStorage` desde el request hasta cualquier capa (`src/tenancy/tenant-context.ts`).
- **Row-level isolation**: cliente Prisma con extensión que inyecta `tenantId` en **toda** operación sobre modelos tenant-owned — no hay camino de acceso "sin scope" (`src/tenancy/tenant-scoped.prisma.ts`).
- **Auth**: `AuthContextMiddleware` (global) verifica el JWT `Authorization: Bearer <token>` y bindea `tenantId`/`userId`/`role` al contexto. La identidad sale **solo del token**; el header `x-tenant-id` es un fallback dev controlado por `ALLOW_TENANT_HEADER=true`.
- **Signup self-service**: `POST /signup` crea `Tenant` + `User` (admin) en una transacción; `Tenant.slug` y `email` únicos → `409`; solo plan `FREE` en el MVP.
- **Modelos**: `Tenant` (registry, admin), `Ticket` (tenant-owned) y `User` (tenant-owned, rol `ADMIN`).
- **Rate limiting**: guard global `@nestjs/throttler` configurable por env (`THROTTLE_LIMIT`/`THROTTLE_TTL_MS`).
- **LlmProvider**: interfaz provider-agnóstica (`src/llm/llm-provider.interface.ts`) con `FakeLlmProvider` (cassette, sin red) y `AnthropicLlmProvider` (JSON Schema generado desde Zod vía `z.toJSONSchema`).
- **Tests**: unit (auth, signup, scoping, LLM) + e2e de onboarding, auth flow y aislamiento cross-tenant con tokens.

## Stack

NestJS 11 · Prisma 7 (driver adapter `@prisma/adapter-pg`, generator `prisma-client` CJS) · Postgres 16 + Redis 7 (Docker) · Zod 4 · Anthropic SDK · Jest + Supertest

## Requisitos

- Node.js 20+ · Docker (con daemon corriendo)

## Setup

```bash
npm install
npm run docker:up        # Postgres (localhost:5433) + Redis (localhost:6379)
npm run db:migrate       # crea/aplica migraciones en la BD dev
npm run start:dev        # API en http://localhost:3000
```

El puerto de Postgres es `5433` (no `5432`) porque asume que puede haber un Postgres local en 5432.

## API

| Método | Ruta             | Scope   | Descripción                                         |
|--------|------------------|---------|-----------------------------------------------------|
| GET    | `/health`        | público | Health check                                        |
| POST   | `/signup`        | público | Onboarding self-service `{ companyName, workspaceName, adminEmail, adminPassword, plan? }` |
| POST   | `/auth/login`    | público | Login `{ email, password }` → `{ accessToken }`     |
| GET    | `/auth/me`       | auth    | Perfil del usuario + tenant (`role`, `plan`, ...)    |
| POST   | `/tickets`       | tenant  | Crea un ticket `{ title }`                          |
| GET    | `/tickets`       | tenant  | Lista tickets del tenant activo (`?status=`)        |
| GET    | `/tickets/:id`   | tenant  | Lee ticket propio (404 si no es del tenant)          |
| PATCH  | `/tickets/:id`   | tenant  | Actualiza ticket propio                             |
| DELETE | `/tickets/:id`   | tenant  | Elimina ticket propio                               |

La identidad del tenant sale del JWT (`Authorization: Bearer <token>`), nunca del body. Rutas públicas: `/health`, `/signup`, `/auth/login`.

## LLM provider

El sistema expone un `LlmProvider` intercambiable (DI token `LLM_PROVIDER`):

```bash
LLM_PROVIDER=fake                 # default: cassette, sin red — dev/tests
LLM_PROVIDER=anthropic            # Anthropic real (requiere ANTHROPIC_API_KEY)
LLM_MODEL=claude-3-5-haiku-latest # modelo por defecto
```

Con `fake`, defines respuestas grabadas (cassettes) que se devuelven cuando el request matchea:

```ts
const provider = app.get<FakeLlmProvider>(LLM_PROVIDER);
provider.add({
  match: { toolName: 'get_ticket', includesText: 'refund' },
  response: { content: '...', toolCalls: [], stopReason: 'end_turn',
              usage: { inputTokens: 0, outputTokens: 0 }, model: 'fake' },
});
```

Los tools se declaran una sola vez con Zod (`inputSchema`) y se convierten a JSON Schema para Anthropic con `z.toJSONSchema` — la misma definición valida la entrada y alimenta el function calling.

## Tests

```bash
npm test          # unit (sin BD)
npm run test:e2e  # e2e sobre la BD de test (la crea y migra automáticamente)
```

Los e2e levantan una BD dedicada `agentdesk_test` (vía `TEST_DATABASE_URL`) y corren el flujo completo de aislamiento.

## Arquitectura de aislamiento (cómo funciona)

1. `AuthContextMiddleware` verifica el JWT (`PUBLIC_PATHS`: `/health`, `/signup`, `/auth/login`) y bindea `tenantId` al `AsyncLocalStorage`. En dev, `ALLOW_TENANT_HEADER=true` acepta `x-tenant-id` como fallback.
2. Todo servicio de dominio de tenant inyecta `TenantScopedPrismaService` (nunca `PrismaService` directo).
3. La extensión Prisma (`$allModels.$allOperations`) fuerza `tenantId` en `create`/`createMany`/`upsert` y lo mergea último en `where` de lecturas/escrituras — el contexto siempre gana. El modelo `Tenant` es admin y no se scopea.
4. Operaciones únicas (`findUnique`/`update`/`delete`) con id de otro tenant no matchean → 404 (sin leak de existencia).
5. En `$transaction` interactivo, el contexto ALS debe envolver el `$transaction` completo (las operaciones internas no ven el store si el `run()` está dentro del callback).

## Roadmap

1. ✅ Base + multi-tenant scaffolding (tests de aislamiento primero)
2. ✅ LLM provider abstraction + fake provider (cassette, provider-agnostic, Anthropic + fake)
3. ✅ Signup self-service + auth JWT (SPC-01)
4. ⬜ Tool registry + tools reales (Zod + contract tests)
5. ⬜ Agent loop básico
6. ⬜ Langfuse (traces + spans + prompt management)
7. ⬜ Model tiering
8. ⬜ Semantic caching + context management (Redis)
9. ⬜ Eval suite (fixtures + runner separado)
