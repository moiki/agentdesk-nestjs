# Tasks: Approval flow para tools requiresApproval

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~850 (src ~350 · tests ~380 · docs ~120) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR1 refactor+pausa → PR2 endpoint → PR3 e2e+docs |
| Delivery strategy | ask-on-risk |

```text
Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High
```

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Señal `awaitingApproval` + refactor neutro del loop (suite verde) | PR 1 | Fases 1–2, standalone |
| 2 | `POST /chat/approve` completo (validación, materialización, resume) | PR 2 | Depende de PR 1 |
| 3 | Suite e2e + docs de contrato | PR 3 | Depende de PR 2 |

## Phase 1: Foundation (tipos)

- [x] 1.1 `src/agent/tools/tool.interface.ts`: agregar `'REJECTED_BY_USER'` a `ToolErrorCode`.
- [x] 1.2 `src/agent/agent.service.ts`: reemplazar interface muerto `PendingApproval` por `type PendingApproval = { toolCalls: LlmToolCall[] }`; agregar `awaitingApproval?: PendingApproval` a `ChatResponse`.

## Phase 2: Refactor neutro + pausa explícita (TDD)

- [x] 2.1 RED: test en `agent.service.spec.ts` que falla porque la pausa no expone `awaitingApproval.toolCalls[]` ni ejecuta side-effects.
- [x] 2.2 Extraer loop a `private runLoop(messages, systemPrompt, acc)` (`acc = { toolCalls, toolResults, usage, iterations }`); `chat()` delega con acc vacío. Sin cambio de comportamiento; suite verde.
- [x] 2.3 Partición 3-vía por iteración: read-only (paralelo) → mutantes sin approval (secuencial) → si quedan `requiresApproval`, pausar exponiendo solo ese subconjunto en `awaitingApproval`. GREEN de 2.1.
- [x] 2.4 Test unit batch mixto (get_ticket + delete_ticket): seguras ejecutadas y respondidas, destructivas pausadas.

## Phase 3: Endpoint `/chat/approve` (TDD)

- [x] 3.1 Crear `src/agent/dto/approve-chat.dto.ts`: `ApproveDecisionDto {toolCallId, approved}`, `ApproveChatDto {conversationHistory, decisions}` con DTOs anidados (`@ValidateNested`).
- [x] 3.2 RED: tests unit de validación 400 — historial sin assistant+toolCalls final; `decision.toolCallId` desconocido; decisions incompletas/extras; tool no registrada o sin `requiresApproval`. Verificar que NO se llama al LLM.
- [x] 3.3 GREEN: `AgentService.resumeWithDecisions()` — validaciones de 3.2 vía `BadRequestException`.
- [x] 3.4 RED/GREEN: materializar decisions — aprobadas via `registry.execute()`, rechazadas como `{success:false, error:{code:'REJECTED_BY_USER'}}`; append `role:'tool'` con `toolCallId`; emitir `agent.approval_granted`/`agent.approval_denied` `{toolCallId, name, iteration}`.
- [x] 3.5 Continuar con `runLoop(messages, acc sembrado)` (iterations=1) hasta `end_turn`/nueva pausa/max_iterations; respuesta con mismo shape.
- [x] 3.6 `chat.controller.ts`: `@Post('approve')` con `ApproveChatDto`.

## Phase 4: E2E

- [x] 4.1 Crear `test/agent-approval.e2e-spec.ts`: flujo feliz — chat pausa (cassette delete_ticket) → `awaitingApproval` presente → approve → ticket borrada exactamente una vez → `end_turn`.
- [x] 4.2 E2E rechazo: resultado sintético, ticket intacta, mensaje del agente comunica cancelación.
- [x] 4.3 E2E negativos: estado falsificado→400; cross-tenant→NOT_FOUND en toolResults; sin JWT→401.

## Phase 5: Docs

- [x] 5.1 Crear `docs/spec-02-agent-approval.md` (contrato FE: detección de pausa, payload de decisions, códigos de error).
- [x] 5.2 `README.md`: fila `POST /chat/approve` en tabla API + sección approval en Agent loop.
