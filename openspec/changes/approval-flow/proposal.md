# Proposal: Approval flow para tools requiresApproval

## Intent

El agent loop pausa ante tools con `requiresApproval: true` (`delete_ticket`), pero **no existe mecanismo para reanudar**: ni señal explícita en el contrato de respuesta ni endpoint de approve/reject. El FE queda bloqueado (ítem 1.3 del checklist del frontend) y el delete vía agente no es utilizable de forma segura. Esta change cierra el flujo human-in-the-loop de extremo a extremo.

## Scope

### In Scope
- Señal explícita `awaitingApproval` en `ChatResponse` cuando el loop pausa.
- Endpoint `POST /chat/approve` que ejecuta/rechaza las toolCalls pendientes y continúa el loop hasta `end_turn`.
- Rechazo con tool result sintético `REJECTED_BY_USER` (mantiene emparejamiento tool_use↔tool_result exigido por proveedores LLM).
- Validaciones anti-falsificación de estado (stateless): correspondencia historial↔decisions, solo tools con `requiresApproval`, re-validación de args vía Zod.
- Refactor neutro: extraer helper compartido de ejecución de tools (`chat()` y resume reusan la misma partición readOnly/mutating).
- Eventos `agent.approval_granted` / `agent.approval_denied`.
- Tests unit + e2e (incl. aislamiento cross-tenant en approve).
- Docs: spec del proyecto + tabla API README.

### Out of Scope
- Persistencia server-side de aprobaciones pendientes (Redis/TTL) — alternativa descartada por romper stateless.
- Streaming / SSE.
- Nuevas tools con approval (solo `delete_ticket` hoy).

## Capabilities

### New Capabilities
- `agent-approval`: pausa, decisión (approve/reject) y resume del agent loop para tools destructivas. Primer spec del proyecto (`openspec/specs/` vacío); absorbe también el contrato de pausa que hoy vive implícito en `/chat`.

### Modified Capabilities
- None (no hay main specs previas).

## Approach

Mantener el invariante **stateless**: el cliente devuelve el `conversationHistory` recibido más sus decisions; el backend valida coherencia, materializa resultados de tool (reales o sintéticos), los appendea como mensajes `role:'tool'` y re-corre el loop existente. Reutilizar `ToolRegistry.execute()` (ya valida args y trunca resultados) y la idempotencia por `toolCallId`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/agent/agent.service.ts` | Modified | `awaitingApproval` en ChatResponse, rama de pausa, `resumeWithDecisions()`, helper extraído |
| `src/agent/dto/chat.dto.ts` | Modified | `ApproveChatDto` |
| `src/agent/chat.controller.ts` | Modified | Ruta `POST chat/approve` (JWT requerido) |
| `src/agent/tools/tool.interface.ts` | Modified | `'REJECTED_BY_USER'` en `ToolErrorCode` |
| `test/*.e2e-spec.ts` | New | Flujos approve/reject/forged/cross-tenant |
| `README.md`, `docs/spec-02-agent-approval.md` | New/Modified | Contrato público |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Historial inválido rompe al proveedor real (tool_use huérfano) | Med | Rechazo SIEMPRE produce tool result sintético; validación estricta 400 antes de tocar el LLM |
| Cliente falsifica estado y ejecuta tools arbitrarias | Med | Solo tools `requiresApproval`; último mensaje = assistant con toolCalls exactos; args re-validados por registry |
| Doble submit aprueba dos veces | Low | Idempotencia mutante por `toolCallId` ya existente |
| Regresión en loop existente | Med | Refactor paso 1 sin cambio de comportamiento + suite verde antes/después |

## Rollback Plan

Revert del PR único. Sin migraciones de BD ni cambios de infraestructura; contrato nuevo es aditivo (campo opcional + endpoint nuevo), por lo que un revert no rompe clientes existentes.

## Dependencies

- Ninguna externa. Requiere suite actual verde (71 unit + 33 e2e).

## Success Criteria

- [ ] Pausa expone `awaitingApproval.toolCalls[]` sin side-effects.
- [ ] Approve ejecuta una vez y el loop termina en `end_turn`; reject NO borra y el agente lo comunica.
- [ ] Estados falsificados → 400 sin llamadas al LLM.
- [ ] Suite completa verde (build/lint/unit/e2e).
