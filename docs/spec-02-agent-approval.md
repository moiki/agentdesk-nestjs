# SPC-02 — Approval flow para tools destructivas (human-in-the-loop)

> **Estado:** spec de implementación · **Base:** `openspec/changes/approval-flow/`
> **Objetivo:** cerrar el flujo de aprobación humana del agent loop: pausa explícita,
> decisión approve/reject vía API y reanudación segura manteniendo stateless.

---

## 1. Contexto

El agent loop pausaba ante tools con `requiresApproval: true` (`delete_ticket`)
pero no existía forma de reanudar: la única señal era `stopReason: 'tool_use'`
(ambigua) y faltaba un endpoint de decisión. Esta spec define el contrato
completo para que el frontend implemente `ApprovalPrompt`.

---

## 2. Contrato para el frontend

### Detección de pausa (respuesta de `POST /chat`)

```jsonc
{
  "message": "I need your approval before proceeding...",
  "toolCalls": [ /* acumuladas */ ],
  "toolResults": [],
  "usage": { "inputTokens": 0, "outputTokens": 0 },
  "stopReason": "tool_use",
  "iterations": 1,
  "awaitingApproval": {
    "toolCalls": [
      { "id": "call-1", "name": "delete_ticket", "arguments": { "ticketId": "..." } }
    ]
  }
}
```

- `awaitingApproval` presente **⇔** hay decisiones pendientes. Ausente = flujo normal.
- Renderizar `ApprovalPrompt` con `name` + `arguments` de cada call pendiente.
- Las tools seguras de un batch mixto **ya se ejecutaron** antes de la pausa
  (aparecen en `toolResults`); solo las destructivas quedan pendientes.

### Decisión (`POST /chat/approve`, JWT requerido)

```jsonc
// Request
{
  "conversationHistory": [ /* estado completo que conserva el cliente */ ],
  "decisions": [ { "toolCallId": "call-1", "approved": true } ]
}
```

Reglas del cliente:
- `conversationHistory` debe terminar en el turno assistant con las toolCalls
  pendientes **sin respuesta** (tal como llegó la pausa).
- `decisions` cubre **exactamente** el set de `awaitingApproval.toolCalls`
  (uno a uno, sin extras ni duplicados).
- Respuesta: mismo shape `ChatResponse` (`end_turn`, nueva pausa o `max_iterations`).

Errores:

| Código | Causa |
|---|---|
| `400` | Historial sin toolCalls sin responder · decisions incompletas/extras/duplicadas · tool inexistente o sin `requiresApproval` · payload inválido (pipe) |
| `401` | Sin JWT |
| `429` | Rate limit global |

### Rechazo

Un rechazo NO ejecuta la tool: se materializa un resultado sintético
`{ success: false, error: { code: 'REJECTED_BY_USER', message } }` emparejado al
`toolCallId` (mantiene válido el historial para Anthropic/OpenAI) y el agente
comunica la cancelación al usuario.

---

## 3. Requisitos funcionales

| ID | Requisito |
|---|---|
| FR-01 | Pausa expone `awaitingApproval.toolCalls[]` con arguments completos y cero side-effects. |
| FR-02 | Batch mixto: tools seguras se ejecutan antes de pausar; solo las destructivas quedan pendientes. |
| FR-03 | Approve ejecuta la tool exactamente una vez (idempotencia por `toolCallId`) y continúa hasta `end_turn`. |
| FR-04 | Reject produce resultado sintético `REJECTED_BY_USER`; la ticket permanece intacta. |
| FR-05 | El resume puede re-pausar si el LLM solicita otra tool con approval. |
| FR-06 | Validación anti-falsificación previa a toda llamada LLM → `400`. |
| FR-07 | Aislamiento multi-tenant intacto: ticket cross-tenant → `NOT_FOUND` a nivel tool. |
| FR-08 | Eventos `agent.approval_granted` / `agent.approval_denied` por decisión (Langfuse futuro). |

## 4. Decisiones de implementación (resumen)

- **Stateless**: el cliente devuelve el historial; no hay estado server-side ni TTL.
- **Partición 3-vía** por iteración: read-only (paralelo) / mutantes (secuencial) /
  `requiresApproval` (pausa). Evita tool_use huérfanos en proveedores reales.
- **Acumuladores sembrados**: el turno pausado cuenta como iteración consumida
  (`iterations = 1`) para el presupuesto de `maxIterations`.
- Pendiente conocido: el resume usa el system prompt default (el custom de la
  conversación original no viaja en `/chat/approve`). Fuera de alcance MVP.

---

*Verificación: `pnpm run build && pnpm run lint && pnpm test && pnpm run test:e2e`*
