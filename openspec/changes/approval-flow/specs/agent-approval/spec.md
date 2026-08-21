# agent-approval Specification

## Purpose

Flujo human-in-the-loop del agent loop: pausa ante tools destructivas (`requiresApproval: true`), decisión explícita del usuario (approve/reject) vía API, y reanudación segura del loop manteniendo el historial válido para cualquier proveedor LLM.

## Requirements

### Requirement: Pausa con señal explícita

El agent loop, ante una toolCall sobre una tool con `requiresApproval: true`, SHALL pausar sin ejecutarla y SHALL incluir en la respuesta el campo `awaitingApproval.toolCalls[]` (id, name, arguments completos) además de `stopReason: 'tool_use'` y un mensaje indicando la espera de aprobación.

#### Scenario: Pausa por delete_ticket

- GIVEN un chat cuyo turno del LLM solicita `delete_ticket`
- WHEN el loop procesa la respuesta del LLM
- THEN la respuesta contiene `awaitingApproval.toolCalls[]` con arguments completos
- AND la ticket objetivo NO es eliminada y ningún side-effect ocurre

#### Scenario: Tools normales no se ven afectadas

- GIVEN un chat que solo invoca tools sin `requiresApproval`
- WHEN el loop termina
- THEN la respuesta NO contiene `awaitingApproval`

### Requirement: Endpoint de decisión

El sistema SHALL exponer `POST /chat/approve` autenticado (JWT) que recibe `{ conversationHistory, decisions: [{ toolCallId, approved }] }`, ejecuta las aprobadas, materializa las rechazadas como resultado sintético, y continúa el loop hasta `end_turn`, `max_iterations` o una nueva pausa. La respuesta SHALL tener el mismo shape que `/chat`.

#### Scenario: Approve ejecuta una sola vez

- GIVEN una pausa con `delete_ticket` pendiente
- WHEN el cliente envía `decisions: [{ toolCallId, approved: true }]`
- THEN la tool se ejecuta exactamente una vez (idempotencia por `toolCallId`)
- AND su resultado real se appendea como mensaje `role:'tool'` con ese `toolCallId`
- AND el loop continúa y la respuesta final tiene `stopReason: 'end_turn'`

#### Scenario: Rechazo produce resultado sintético

- GIVEN una pausa con `delete_ticket` pendiente
- WHEN el cliente responde `approved: false`
- THEN la tool NO se ejecuta
- AND se appendea `{ success: false, error: { code: 'REJECTED_BY_USER' } }` como `role:'tool'`
- AND el agente comunica la cancelación y la ticket sigue existiendo

#### Scenario: Re-pausa encadenada

- GIVEN una continuación donde el LLM solicita otra tool con approval
- WHEN el loop procesa esa solicitud durante el resume
- THEN retorna `awaitingApproval` nuevamente con la nueva pendiente

### Requirement: Validación anti-falsificación

El endpoint SHALL validar antes de invocar al LLM y SHALL responder `400` si: el último mensaje del historial no es `assistant` con `toolCalls`; algún `decision.toolCallId` no corresponde a esas toolCalls; falta o sobra alguna decision respecto del set pendiente; o la tool referenciada no está registrada o no tiene `requiresApproval`. Los argumentos SHALL re-validarse contra el schema Zod de la tool.

#### Scenario: Estado falsificado rechazado

- GIVEN un historial que no termina en assistant+toolCalls coherente con las decisions
- WHEN el cliente llama `/chat/approve`
- THEN recibe `400` y NO se invoca al LLM ni se ejecuta tool alguna

### Requirement: Aislamiento multi-tenant

El flujo de aprobación SHALL derivar el tenant exclusivamente del JWT. Operaciones sobre recursos de otro tenant SHALL fallar como `NOT_FOUND` a nivel de tool, sin revelar existencia.

#### Scenario: Ticket cross-tenant en approve

- GIVEN un usuario autenticado del tenant A
- WHEN aprueba un `delete_ticket` con el id de una ticket del tenant B
- THEN el resultado de la tool es `NOT_FOUND` y la ticket B permanece intacta

### Requirement: Eventos de observabilidad

Por cada decisión materializada, el sistema SHALL emitir `agent.approval_granted` o `agent.approval_denied` (con toolCallId, name e iteration) vía EventEmitter2.

#### Scenario: Emisión de eventos

- GIVEN una llamada a `/chat/approve` con una decisión aprobada y una rechazada
- WHEN el backend materializa ambas
- THEN emite un evento por cada decisión con su tipo correspondiente
