# Design: Approval flow para tools requiresApproval

## Technical Approach

Mantener el invariante **stateless**: `/chat/approve` recibe el historial que el cliente conserva + decisions; el backend valida coherencia, materializa resultados (reales o sintéticos) y re-corre el mismo loop de `AgentService.chat()`. Refactor en dos pasos: (1) extraer el loop a método privado reutilizable sin cambio de comportamiento, (2) añadir resume encima.

## Architecture Decisions

### Decision: Señal de pausa explícita en ChatResponse
**Choice**: campo opcional `awaitingApproval?: { toolCalls: LlmToolCall[] }` en la rama de pausa. **Alternativas**: inferir solo de `stopReason === 'tool_use'` (frágil para FE espejo manual); estado server-side con approvalId (rompe stateless, TTL extra). **Rationale**: contrato aditivo y explícito; FE ya espeja tipos.

### Decision: Resume stateless vía historial del cliente
**Choice**: `POST /chat/approve { conversationHistory, decisions }`. **Alternativas**: Redis + TTL + approvalId. **Rationale**: coherente con decisión de arquitectura vigente (historial en cliente); cero infra nueva; scoping ALS sigue aplicando por JWT.

### Decision: Partición de tools en 3 categorías
**Choice**: por iteración ejecutar read-only (paralelo) + mutantes sin approval (secuencial) y pausar SOLO si quedan `requiresApproval`; `awaitingApproval` expone únicamente ese subconjunto. **Alternativa**: pausar el batch completo como hoy. **Rationale**: evita tool_use huérfanos (Anthropic exige tool_result emparejado) si el LLM mezcla llamadas seguras+destructivas; las seguras se responden y el set pendiente es 100% decidible.

### Decision: Validación estricta antes del LLM
**Choice**: `400 BadRequestException` si: último mensaje ≠ assistant con `toolCalls` no vacío; `decisions` no cubre exactamente el set pendiente por `toolCallId`; tool inexistente o sin `requiresApproval`; args inválidos (re-chequeo Zod en `registry.execute()`). **Rationale**: el cliente no puede falsificar qué es aprobable ni provocar ejecuciones fuera del flujo; falla barata antes de gastar tokens.

### Decision: Acumuladores sembrados en el loop
**Choice**: loop privado recibe `{ messages, acc }` con `acc = { toolCalls, toolResults, usage, iterations }`; resume siembra `acc` con los resultados materializados e `iterations = 1` (el turno pausado ya consumió una iteración). Budget de tokens/wall-clock continúa fresco por request. **Rationale**: contabilidad correcta de `maxIterations` y respuesta única coherente.

## Data Flow

    FE                          BE (/chat/approve)                      LLM
     │  history+decisions ───────▶ validación 400? ──▶ (abort)      │
     │                             │ ok                              │
     │                             ├─ approved ─▶ ToolRegistry.execute()
     │                             ├─ rejected ─▶ { REJECTED_BY_USER }
     │                             ├─ append role:'tool' msgs       │
     │                             ├─ emit approval_granted/denied  │
     │                             └─ runLoop(messages, acc) ───────▶ complete()
     │  ◀── ChatResponse (end_turn | awaitingApproval | max_iterations)

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/agent/dto/approve-chat.dto.ts` | Create | `ApproveChatDto` + `ApproveDecisionDto` + DTOs anidados de ChatMessage |
| `src/agent/agent.service.ts` | Modify | Extraer `runLoop()`; pausa con `awaitingApproval`; partición 3-vía; `resumeWithDecisions()`; eventos |
| `src/agent/chat.controller.ts` | Modify | `@Post('approve')` |
| `src/agent/tools/tool.interface.ts` | Modify | `'REJECTED_BY_USER'` en `ToolErrorCode` |
| `test/agent-approval.e2e-spec.ts` | Create | Flujos HTTP completos con cassettes |
| `src/agent/agent.service.spec.ts` | Modify | Casos unit de pausa/resume/validación |
| `README.md`, `docs/spec-02-agent-approval.md` | Modify/Create | Contrato público |

## Interfaces / Contracts

```ts
// Respuesta de pausa (aditivo)
interface ChatResponse {
  // ...existente
  awaitingApproval?: { toolCalls: LlmToolCall[] };
}

// POST /chat/approve (JWT requerido; NO está en PUBLIC_PATHS)
class ApproveDecisionDto {
  toolCallId!: string;   // @IsString
  approved!: boolean;    // @IsBoolean
}
class ApproveChatDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ChatMessageDto)
  conversationHistory!: ChatMessageDto[];   // role ∈ user|assistant|tool
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true })
  @Type(() => ApproveDecisionDto)
  decisions!: ApproveDecisionDto[];
}

interface PendingApproval { toolCalls: LlmToolCall[] }  // reemplaza al interface muerto actual
```

Eventos: `agent.approval_granted` / `agent.approval_denied` → `{ toolCallId, name, iteration }`.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Pausa expone `awaitingApproval`; batch mixto ejecuta seguras y pausa destructivas; 5 casos de validación 400; rechazo sintético; eventos; continuación `end_turn`; seeding de `iterations` | `agent.service.spec.ts` con FakeLlmProvider + registry real de TicketTools mockeando TicketsService |
| E2E | approve borra ticket real (una vez); reject preserva; falsificado→400; cross-tenant→NOT_FOUND; sin JWT→401 | `test/agent-approval.e2e-spec.ts`, supertest + cassettes `hasToolCalls` |

## Migration / Rollout

No migration required. Contrato aditivo (campo opcional + endpoint nuevo); rollback = revert del PR.

## Open Questions

None — la ambigüedad de batch mixto se resuelve con la partición 3-vía (decisión 3).
