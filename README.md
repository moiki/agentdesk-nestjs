# AgentDesk — Agentic AI Gateway multi-tenant en NestJS

Backend NestJS que actúa como gateway de agentes de IA para múltiples clientes (tenants): cada tenant tiene su propio agente con tool calling, datos completamente aislados, y todo trazado para observabilidad.

## Estado actual — Agent loop + tool registry

Multi-tenant scaffolding (Fase 1) + capa de LLM intercambiable (Fase 2) + auth JWT + **agent loop con tool calling**:

- **Tenancy**: contexto de tenant propagado vía `AsyncLocalStorage` desde el request hasta cualquier capa (`src/tenancy/tenant-context.ts`).
- **Row-level isolation**: cliente Prisma con extensión que inyecta `tenantId` en **toda** operación sobre modelos tenant-owned — no hay camino de acceso "sin scope" (`src/tenancy/tenant-scoped.prisma.ts`).
- **Auth**: `AuthContextMiddleware` (global) verifica el JWT `Authorization: Bearer <token>` y bindea `tenantId`/`userId`/`role` al contexto. La identidad sale **solo del token**; el header `x-tenant-id` es un fallback dev controlado por `ALLOW_TENANT_HEADER=true`.
- **Signup self-service**: `POST /signup` crea `Tenant` + `User` (admin) en una transacción; `Tenant.slug` y `email` únicos → `409`; solo plan `FREE` en el MVP.
- **Modelos**: `Tenant` (registry, admin), `Ticket` (tenant-owned) y `User` (tenant-owned, rol `ADMIN`).
- **Rate limiting**: guard global `@nestjs/throttler` configurable por env (`THROTTLE_LIMIT`/`THROTTLE_TTL_MS`).
- **LlmProvider**: interfaz provider-agnóstica (`src/llm/llm-provider.interface.ts`) con `FakeLlmProvider` (cassette, sin red), `AnthropicLlmProvider` (JSON Schema generado desde Zod vía `z.toJSONSchema`) y `OpenAICompatibleProvider` (cualquier endpoint chat-completions compatible: Groq, OpenAI, ...).
- **Tool registry**: `ToolRegistry` centraliza tools (Zod schema → LLM + executor). `TicketTools` registra 5 tools CRUD de tickets.
- **Agent loop**: `AgentService` orquesta el loop: LLM → tool_use → execute → append results → loop hasta `end_turn` o `maxIterations`. Endpoint `POST /chat`.
- **Tests**: 56 unit + 33 e2e (auth, signup, scoping, LLM, agent loop, aislamiento cross-tenant via agent).

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

## Levantar todo con Docker

El `docker-compose.yml` levanta el stack **completo** (incluida la app NestJS en modo producción) sin necesidad de Node.js local:

```bash
# 1) Arranca Postgres + Redis + la app (imagen de producción en http://localhost:3000)
docker compose up -d

# 2) Aplica las migraciones de Prisma (one-off, se detiene al terminar)
docker compose --profile tools run --rm migrate

# Ver logs de la app
docker compose logs -f app
```

Para **actualizar** tras cambiar código o env vars:

```bash
docker compose up -d --build        # reconstruye la imagen de la app
```

Para **detener**:

```bash
docker compose down                 # detiene los contenedores
docker compose down -v              # + elimina los volúmenes (borra la BD y Redis)
```

### Servicios

| Servicio | Imagen | Puerto externo | Notas |
|---|---|---|---|
| `app` | build local (NestJS, multi-stage) | `3000` | Arranca tras el healthcheck de Postgres y Redis |
| `postgres` | `postgres:16-alpine` | `5433` | Volumen persistente `agentdesk-pgdata` |
| `redis` | `redis:7-alpine` | `6379` | Volumen persistente `agentdesk-redisdata` |
| `migrate` | build local | — | One-off (`profile: tools`), solo aplica migraciones y sale |

### Configuración via `.env`

Todas las variables del compose se alimentan del archivo `.env` (crea uno a partir de `.env.example`). Las más relevantes:

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto de la app |
| `CORS_ORIGINS` | `*` | Orígenes permitidos (comma-separated). Para dev con FE en localhost:5173 → `http://localhost:5173` |
| `LLM_PROVIDER` | `fake` | `fake` / `anthropic` / `groq` |
| `GROQ_API_KEY` | — | Requerida si `LLM_PROVIDER=groq` |
| `ANTHROPIC_API_KEY` | — | Requerida si `LLM_PROVIDER=anthropic` |
| `DATABASE_URL` | apunta a `postgres` interno | Compuesta automáticamente desde `POSTGRES_*` |

> Nota: la app espera a que Postgres y Redis pasen su healthcheck antes de arrancar (`depends_on: condition: service_healthy`). Si la app crashea al inicio, revisa `docker compose logs app`.

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
| POST   | `/chat`          | auth    | Agent loop `{ message, systemPrompt?, conversationId? }` → respuesta del agente + `conversationId` |
| POST   | `/chat/approve`  | auth    | Reanuda tras pausa de aprobación `{ conversationId, decisions }` → respuesta del agente |

La identidad del tenant sale del JWT (`Authorization: Bearer <token>`), nunca del body. Rutas públicas: `/health`, `/signup`, `/auth/login`.

## Agent loop

El endpoint `POST /chat` ejecuta un loop agéntico:

1. El usuario envía un mensaje.
2. `AgentService` construye un `LlmRequest` con los tools registrados (Zod → JSON Schema).
3. Llama a `LlmProvider.complete()`.
4. Si `stopReason === 'tool_use'`: ejecuta los tools via `ToolRegistry`, appende resultados al historial, repite.
5. Si `stopReason !== 'tool_use'` o se alcanza `AGENT_MAX_ITERATIONS`: retorna la respuesta.

**Tools disponibles** (registrados por `TicketTools`):

| Tool | Descripción | Input |
|------|-------------|-------|
| `create_ticket` | Crea un ticket | `{ title: string }` |
| `list_tickets` | Lista tickets del tenant | `{ status?: TicketStatus }` |
| `get_ticket` | Lee un ticket por UUID | `{ ticketId: string }` |
| `update_ticket` | Actualiza title/status | `{ ticketId, title?, status? }` |
| `delete_ticket` | Elimina un ticket | `{ ticketId: string }` (requiere aprobación) |

### Aprobación humana (`requiresApproval`)

Las tools destructivas (`delete_ticket`) pausan el loop antes de ejecutarse.
En la pausa, la respuesta incluye `awaitingApproval.toolCalls[]` con los
argumentos completos; las llamadas seguras de un batch mixto ya se ejecutaron.

La conversación se **persiste en servidor** (`conversationId` devuelto por
`POST /chat`), por lo que el cliente no tiene que reenviar el historial. Al
pausar, el estado queda recuperable aunque el cliente se caiga o recargue.

El cliente decide con `POST /chat/approve` usando solo el `conversationId` más
una decisión por call pendiente:

```jsonc
// POST /chat/approve
{
  "conversationId": "uuid-del-conversation",
  "decisions": [ { "toolCallId": "call-1", "approved": true } ]
}
```

- Aprobada → se ejecuta una vez y el loop continúa hasta `end_turn`.
- Rechazada → resultado sintético `REJECTED_BY_USER`; nada se elimina.
- Calls pendientes no cubiertas por `decisions` → se descartan como
  `REJECTED_BY_USER` (recuperables) en vez de romper la reanudación.
- `conversationId` sin pausa pendiente → `400` sin llamar al LLM.

Contrato completo para el FE: `docs/spec-02-agent-approval.md`.

```bash
AGENT_MAX_ITERATIONS=10      # límite de ciclos del loop
AGENT_SYSTEM_PROMPT=         # override del system prompt default
```

## LLM provider

El sistema expone un `LlmProvider` intercambiable (DI token `LLM_PROVIDER`):

```bash
LLM_PROVIDER=fake                 # default: cassette, sin red — dev/tests
LLM_PROVIDER=anthropic            # Anthropic real (requiere ANTHROPIC_API_KEY)
LLM_PROVIDER=groq                 # Groq vía API OpenAI-compatible (requiere GROQ_API_KEY)

# Solo para groq:
GROQ_BASE_URL=https://api.groq.com/openai/v1   # default
GROQ_MODEL=openai/gpt-oss-120b                 # default; debe soportar tool calling

# Smoke test contra el modelo real (NUNCA corre en Jest/CI):
pnpm run test:groq
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
npm test          # unit (sin BD) — 56 tests
npm run test:e2e  # e2e sobre la BD de test — 33 tests
```

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
4. ✅ Tool registry + tools reales (Zod + ticket CRUD tools)
5. ✅ Agent loop básico (`POST /chat`, loop con maxIterations, tool execution)
6. ⬜ Langfuse (traces + spans + prompt management)
7. ⬜ Model tiering
8. ⬜ Semantic caching + context management (Redis)
9. ⬜ Eval suite (fixtures + runner separado)
