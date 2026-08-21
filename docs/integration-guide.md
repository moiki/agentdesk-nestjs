# Guía de integración — Backend AgentDesk

> **Para quién:** equipo frontend / cualquier cliente que consuma la API.
> **Base URL local:** `http://localhost:3000` · **Auth:** JWT Bearer · **Formato:** JSON
> **Specs fuente:** `docs/spec-01-tenant-signup-auth.md`, `docs/spec-02-agent-approval.md`

---

## 1. Quickstart (5 llamadas)

```bash
API=http://localhost:3000

# 1) Registrar tenant + admin
curl -sX POST $API/signup -H 'Content-Type: application/json' -d '{
  "companyName": "Acme", "workspaceName": "acme",
  "adminEmail": "admin@acme.dev", "adminPassword": "S3gura!2026"
}'
# → { "tenantId": "...", "adminUserId": "...", "plan": "FREE" }   (NO devuelve token)

# 2) Login
TOKEN=$(curl -sX POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@acme.dev","password":"S3gura!2026"}' | jq -r .accessToken)

# 3) Crear ticket (para que el agente tenga algo que borrar)
TICKET=$(curl -sX POST $API/tickets -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"title":"Soporte impresora"}')
echo $TICKET

# 4) Pedirle al agente algo destructivo → el loop PAUSA esperando aprobación
curl -sX POST $API/chat -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Elimina el ticket de la impresora usando la herramienta"}'

# 5) Aprobar la acción pendiente → se ejecuta y responde
curl -sX POST $API/chat/approve -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{ "conversationHistory": [...], "decisions":[{"toolCallId":"...","approved":true}] }'
```

---

## 2. Autenticación

| Endpoint | Auth | Body | Respuesta |
|---|---|---|---|
| `POST /signup` | — | `{ companyName, workspaceName, adminEmail, adminPassword, plan? }` | `201 { tenantId, adminUserId, plan }` |
| `POST /auth/login` | — | `{ email, password }` | `200 { accessToken }` |
| `GET /auth/me` | Bearer | — | `200 { user, tenant }` |

Reglas:
- **El token es la única identidad de tenant** — no hay header `x-tenant-id`; jamás lo necesitas.
- `workspaceName`: slug `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$` (2–40 chars).
- Email o workspace duplicado → `409 Conflict`.
- Envía `Authorization: Bearer <accessToken>` en todo endpoint marcado *auth*.

## 3. Convenciones transversales

- **Errores**: formato Nest estándar `{ statusCode, message, error }`. `message` puede ser string o array (validaciones).
- **Campos desconocidos = 400**: el ValidationPipe usa `forbidNonWhitelisted` → no envíes propiedades extra.
- **Rate limit**: ~100 req/min por IP → `429` con `Retry-After`.
- **CORS**: configurable por env (`CORS_ORIGINS`, default `*`) — coordinar con backend para producción.
- **Sin paginación ni streaming todavía** (roadmap).

## 4. Tickets CRUD

| Método | Ruta | Notas |
|---|---|---|
| `POST /tickets` | auth | `{ title }` → `201 Ticket` |
| `GET /tickets` | auth | `?status=OPEN\|IN_PROGRESS\|RESOLVED\|CLOSED` (único filtro) |
| `GET /tickets/:id` | auth | Otro tenant → `404` (no revela existencia) |
| `PATCH /tickets/:id` | auth | `{ title?, status? }` |
| `DELETE /tickets/:id` | auth | Borra directo (sin aprobación vía REST; la aprobación aplica solo al agente) |

## 5. Chat stateless (`POST /chat`)

El backend **no guarda conversación**: tú conservas el historial y lo reenvías.

```jsonc
// Request
{
  "message": "¿Qué tickets hay abiertos?",
  "conversationHistory": [          // opcional — estado que TÚ persistes
    { "role": "user", "content": "hola" },
    { "role": "assistant", "content": "¡Hola! ¿en qué te ayudo?" }
  ],
  "systemPrompt": "Eres soporte de Acme..."   // opcional
}
```

```jsonc
// Response — ChatResponse
{
  "message": "Hay 2 tickets abiertos...",
  "toolCalls":   [ { "id":"call_1", "name":"list_tickets", "arguments":{"status":"OPEN"} } ],
  "toolResults": [ { "id":"call_1", "name":"list_tickets", "success": true,
                     "result": [ /* datos o error {code,message} */ ] } ],
  "usage": { "inputTokens": 812, "outputTokens": 96 },
  "stopReason": "end_turn",
  "iterations": 1,
  "awaitingApproval": null            // presente SOLO cuando hay pausa (ver §6)
}
```

Interpretación del `stopReason`:

| Valor | Significado | Acción FE |
|---|---|---|
| `end_turn` | Respuesta final lista | Mostrar `message` |
| `tool_use` | Revisa `awaitingApproval` | Si existe → flujo §6; si no, es interno del loop |
| `max_iterations` | Cortó por presupuesto de vueltas | Informar e invitar a reformular |
| `max_tokens` | Modelo agotó tokens de salida | Igual que arriba |
| `stop_sequence` / `error` | Corte especial / fallo LLM (con retry interno ya aplicado) | Mostrar genérico + reintentar |

Notas:
- `toolCalls`/`toolResults` vienen **siempre** (arrays vacíos si no hubo tools) — acumulados de toda la conversación del turno.
- Para continuar una conversación, appendea `{user}` y `{assistant}` al historial que ya tienes.

### Herramientas disponibles hoy

| Tool | Efecto | Flags |
|---|---|---|
| `create_ticket` | Crea ticket | mutating |
| `list_tickets` / `get_ticket` | Lectura | read-only (paralelizables) |
| `update_ticket` | Cambia título/estado | mutating |
| `delete_ticket` | **Elimina** | mutating + **requiresApproval** |

Los errores de tool NO son errores HTTP: llegan dentro de `toolResults[].result.code`
(`NOT_FOUND | VALIDATION_ERROR | INTERNAL_ERROR | REJECTED_BY_USER`) con `success:false`.

## 6. Approval flow — human-in-the-loop ⭐

Máquina de estados desde el punto de vista del FE:

```
                    POST /chat
                        │
              ┌─── awaitingApproval ausente
              │              └──► fin (end_turn u otro) ── mostrar message
              │
              └─── awaitingApproval.toolCalls[]
                           │  renderizar <ApprovalPrompt> con name+arguments
                           ▼
                    usuario decide (approve/reject por cada call)
                           │
                    POST /chat/approve
             { conversationHistory, decisions }
                           │
              ┌── nueva pausa (awaitingApproval) ── repetir
              └── end_turn ──► mostrar message
```

### Detección de pausa
- `awaitingApproval.toolCalls[]` trae `{ id, name, arguments }` **completos** → pinta confirmación (ej: “¿Eliminar ticket X?”).
- Si el turno pedía varias cosas, las herramientas seguras **ya se ejecutaron** antes de pausar: revisa también `toolResults`.

### Decisión (`POST /chat/approve`, auth)

```jsonc
{
  // El MISMO historial que conservas — debe terminar en el turno assistant
  // con las toolCalls pendientes SIN respuesta (tal como llegó la pausa):
  "conversationHistory": [
    { "role": "user", "content": "Elimina el ticket X" },
    { "role": "assistant", "content": "", "toolCalls": [ {"id":"call_1","name":"delete_ticket","arguments":{"ticketId":"..."}} ] }
  ],
  "decisions": [ { "toolCallId": "call_1", "approved": true } ]
}
```

Respuesta: mismo shape `ChatResponse`. Puede volver a pausar (el modelo pidió
otra herramienta destructiva) → repite el ciclo.

| approved | Efecto |
|---|---|
| `true` | La tool se ejecuta **exactamente una vez** y el loop continúa hasta `end_turn` |
| `false` | No se ejecuta nada; el modelo recibe `REJECTED_BY_USER` y comunica la cancelación |

### Checklist de validación (todo esto da `400`, antes de llamar al LLM)

- [ ] El historial contiene las toolCalls pendientes **sin responder** (sin mensaje `role:'tool'` con ese `toolCallId`)
- [ ] `decisions` cubre **exactamente** ese set — sin faltantes, extras ni duplicados
- [ ] Las tools referenciadas existen y requieren aprobación (hoy: solo `delete_ticket`)
- Sin JWT → `401`. Payload malformado → `400` (pipe). Ticket de otro tenant → `success:false code:'NOT_FOUND'` dentro de `toolResults` (no es 403).

> Regla de oro: **persiste el historial tal cual** y reenvíalo íntegro. Nunca
> inventes ni edites toolCalls/ids — el backend valida contra falsificación.

## 7. Salud y operación

- `GET /health` (público) → `{ status, db, timestamp }` — útil para readiness del deploy.

## 8. Reference rápida

| Método | Ruta | Auth | Propósito |
|---|---|---|---|
| POST | `/signup` | — | Alta self-service de tenant+admin |
| POST | `/auth/login` | — | JWT |
| GET | `/auth/me` | ✅ | Perfil |
| GET | `/health` | — | Status DB |
| CRUD | `/tickets` | ✅ | Tickets del tenant |
| POST | `/chat` | ✅ | Agent loop (stateless) |
| POST | `/chat/approve` | ✅ | Reanudar tras aprobación humana |

---
*Última actualización: 2026-08-21 · Backend: NestJS 11 · Tests: 92 unit + 41 e2e verdes*
