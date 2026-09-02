# AgentDesk — Multi-tenant Agentic AI Gateway in NestJS

NestJS backend that acts as an AI agent gateway for multiple clients (tenants): each tenant has its own agent with tool calling, completely isolated data, and full tracing for observability.

## Stack

NestJS 11 · Prisma 7 (driver adapter `@prisma/adapter-pg`, generator `prisma-client` CJS) · Postgres 16 + Redis 7 (Docker) · Zod 4 · Anthropic SDK · Jest + Supertest

## Requirements

- Node.js 20+ · Docker (with daemon running)

## Setup

```bash
npm install
npm run docker:up        # Postgres (localhost:5433) + Redis (localhost:6379)
npm run db:migrate       # creates/applies migrations on the dev DB
npm run start:dev        # API at http://localhost:3000
```

The Postgres port is `5433` (not `5432`) because it assumes there may be a local Postgres on 5432.

## Running Everything with Docker

The `docker-compose.yml` runs the **complete** stack (including the NestJS app in production mode) without needing local Node.js:

```bash
# 1) Start Postgres + Redis + the app (production image at http://localhost:3000)
docker compose up -d

# 2) Apply Prisma migrations (one-off, stops when done)
docker compose --profile tools run --rm migrate

# View app logs
docker compose logs -f app
```

To **update** after changing code or env vars:

```bash
docker compose up -d --build        # rebuilds the app image
```

To **stop**:

```bash
docker compose down                 # stops the containers
docker compose down -v              # + removes volumes (deletes the DB and Redis)
```

### Services

| Service | Image | External port | Notes |
|---|---|---|---|
| `app` | local build (NestJS, multi-stage) | `3000` | Starts after Postgres and Redis healthcheck |
| `postgres` | `postgres:16-alpine` | `5433` | Persistent volume `agentdesk-pgdata` |
| `redis` | `redis:7-alpine` | `6379` | Persistent volume `agentdesk-redisdata` |
| `migrate` | local build | — | One-off (`profile: tools`), applies migrations and exits |

### Configuration via `.env`

All compose variables are fed from the `.env` file (create one from `.env.example`). Most relevant ones:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | App port |
| `CORS_ORIGINS` | `*` | Allowed origins (comma-separated). For dev with FE on localhost:5173 → `http://localhost:5173` |
| `LLM_PROVIDER` | `fake` | `fake` / `anthropic` / `groq` |
| `GROQ_API_KEY` | — | Required if `LLM_PROVIDER=groq` |
| `ANTHROPIC_API_KEY` | — | Required if `LLM_PROVIDER=anthropic` |
| `DATABASE_URL` | points to internal `postgres` | Composed automatically from `POSTGRES_*` |

> Note: the app waits for Postgres and Redis to pass their healthcheck before starting (`depends_on: condition: service_healthy`). If the app crashes at startup, check `docker compose logs app`.

## API

| Method | Route            | Scope   | Description                                        |
|--------|------------------|---------|-----------------------------------------------------|
| GET    | `/health`        | public  | Health check                                        |
| POST   | `/signup`        | public  | Self-service onboarding `{ companyName, workspaceName, adminEmail, adminPassword, plan? }` |
| POST   | `/auth/login`    | public  | Login `{ email, password }` → `{ accessToken }` + HttpOnly session cookies |
| POST   | `/auth/refresh`  | public  | Rotate the refresh cookie → new `{ accessToken }` (persists session across tabs/reloads) |
| POST   | `/auth/logout`   | public  | Invalidate the refresh token and clear session cookies |
| GET    | `/auth/me`       | auth    | User + tenant profile (`role`, `plan`, ...)         |
| POST   | `/tickets`       | tenant  | Create a ticket `{ title }`                         |
| GET    | `/tickets`       | tenant  | List active tenant tickets (`?status=`)             |
| GET    | `/tickets/:id`   | tenant  | Read own ticket (404 if not belonging to tenant)    |
| PATCH  | `/tickets/:id`   | tenant  | Update own ticket                                   |
| DELETE | `/tickets/:id`   | tenant  | Delete own ticket                                   |
| POST   | `/chat`          | auth    | Agent loop `{ message, systemPrompt?, conversationId? }` → agent response + `conversationId` |
| POST   | `/chat/approve`  | auth    | Resume after approval pause `{ conversationId, decisions }` → agent response |

Tenant identity comes from the JWT (`Authorization: Bearer <token>` or the HttpOnly `access_token` cookie), never from the body. Public routes: `/health`, `/signup`, `/auth/login`, `/auth/refresh`, `/auth/logout`.

### Session persistence (cookies)

Sessions are kept in **HttpOnly cookies** set on login, so they survive opening
new tabs and page reloads without the client re-sending credentials:

- `access_token` — short-lived JWT (default 1h), read by the middleware when no
  `Authorization` header is present.
- `refresh_token` — long-lived (default 30d), rotating, revocable. Also stored
  hashed in the `RefreshToken` table (single-use: each `/auth/refresh` consumes
  and re-issues it).

On app boot the frontend should call `POST /auth/refresh` (which only needs the
refresh cookie) to obtain a fresh access token. `POST /auth/logout` revokes all
refresh tokens for the user and clears the cookies.

```bash
COOKIE_ACCESS_TTL_MS=3600000      # access cookie lifetime (default 1h)
COOKIE_REFRESH_TTL_MS=2592000000  # refresh cookie lifetime (default 30d)
COOKIE_SECURE=false               # true in production (HTTPS only)
COOKIE_SAME_SITE=lax              # lax | strict | none
```

CORS `credentials` is already enabled, so the cookies work cross-origin (e.g.
FE on `localhost:5173` → API on `localhost:3000`).

## Agent loop

The `POST /chat` endpoint runs an agentic loop:

1. The user sends a message.
2. `AgentService` builds an `LlmRequest` with registered tools (Zod → JSON Schema).
3. Calls `LlmProvider.complete()`.
4. If `stopReason === 'tool_use'`: executes tools via `ToolRegistry`, appends results to history, repeats.
5. If `stopReason !== 'tool_use'` or `AGENT_MAX_ITERATIONS` is reached: returns the response.

**Available tools** (registered by `TicketTools`):

| Tool | Description | Input |
|------|-------------|-------|
| `create_ticket` | Creates a ticket | `{ title: string }` |
| `list_tickets` | Lists tenant tickets | `{ status?: TicketStatus }` |
| `get_ticket` | Reads a ticket by UUID | `{ ticketId: string }` |
| `update_ticket` | Updates title/status | `{ ticketId, title?, status? }` |
| `delete_ticket` | Deletes a ticket | `{ ticketId: string }` (requires approval) |

### Human approval (`requiresApproval`)

Destructive tools (`delete_ticket`) pause the loop before executing.
On pause, the response includes `awaitingApproval.toolCalls[]` with the
full arguments; safe calls from a mixed batch have already been executed.

The conversation is **persisted on the server** (`conversationId` returned by
`POST /chat`), so the client doesn't have to resend the history. When
paused, the state is recoverable even if the client crashes or reloads.

The client decides via `POST /chat/approve` using only the `conversationId` plus
one decision per pending call:

```jsonc
// POST /chat/approve
{
  "conversationId": "uuid-of-conversation",
  "decisions": [ { "toolCallId": "call-1", "approved": true } ]
}
```

- Approved → executes once and the loop continues until `end_turn`.
- Rejected → synthetic `REJECTED_BY_USER` result; nothing is deleted.
- Pending calls not covered by `decisions` → discarded as
  `REJECTED_BY_USER` (recoverable) instead of breaking the resumption.
- `conversationId` with no pending pause → `400` without calling the LLM.

Full contract for the FE: `docs/spec-02-agent-approval.md`.

```bash
AGENT_MAX_ITERATIONS=10      # loop cycle limit
AGENT_SYSTEM_PROMPT=         # override default system prompt
```

## LLM provider

The system exposes a swappable `LlmProvider` (DI token `LLM_PROVIDER`):

```bash
LLM_PROVIDER=fake                 # default: cassette, no network — dev/tests
LLM_PROVIDER=anthropic            # Real Anthropic (requires ANTHROPIC_API_KEY)
LLM_PROVIDER=groq                 # Groq via OpenAI-compatible API (requires GROQ_API_KEY)

# Only for groq:
GROQ_BASE_URL=https://api.groq.com/openai/v1   # default
GROQ_MODEL=openai/gpt-oss-120b                 # default; must support tool calling

# Smoke test against the real model (NEVER runs in Jest/CI):
pnpm run test:groq
LLM_MODEL=claude-3-5-haiku-latest # default model
```

With `fake`, you define recorded responses (cassettes) that are returned when the request matches:

```ts
const provider = app.get<FakeLlmProvider>(LLM_PROVIDER);
provider.add({
  match: { toolName: 'get_ticket', includesText: 'refund' },
  response: { content: '...', toolCalls: [], stopReason: 'end_turn',
              usage: { inputTokens: 0, outputTokens: 0 }, model: 'fake' },
});
```

Tools are declared once with Zod (`inputSchema`) and converted to JSON Schema for Anthropic via `z.toJSONSchema` — the same definition validates input and feeds function calling.

## Tests

```bash
npm test          # unit (no DB) — 56 tests
npm run test:e2e  # e2e on test DB — 33 tests
```

## Isolation architecture (how it works)

1. `AuthContextMiddleware` verifies the JWT (`PUBLIC_PATHS`: `/health`, `/signup`, `/auth/login`) and binds `tenantId` to `AsyncLocalStorage`. In dev, `ALLOW_TENANT_HEADER=true` accepts `x-tenant-id` as a fallback.
2. Every tenant domain service injects `TenantScopedPrismaService` (never `PrismaService` directly).
3. The Prisma extension (`$allModels.$allOperations`) forces `tenantId` on `create`/`createMany`/`upsert` and merges it last into `where` for reads/writes — the context always wins. The `Tenant` model is admin and not scoped.
4. Single operations (`findUnique`/`update`/`delete`) with another tenant's id don't match → 404 (no existence leak).
5. In interactive `$transaction`, the ALS context must wrap the entire `$transaction` (internal operations don't see the store if the `run()` is inside the callback).

## Roadmap

1. ✅ Base + multi-tenant scaffolding (isolation tests first)
2. ✅ LLM provider abstraction + fake provider (cassette, provider-agnostic, Anthropic + fake)
3. ✅ Self-service signup + JWT auth (SPC-01)
4. ✅ Tool registry + real tools (Zod + ticket CRUD tools)
5. ✅ Basic agent loop (`POST /chat`, loop with maxIterations, tool execution)
6. ⬜ Langfuse (traces + spans + prompt management)
7. ⬜ Model tiering
8. ⬜ Semantic caching + context management (Redis)
9. ⬜ Eval suite (fixtures + separate runner)
