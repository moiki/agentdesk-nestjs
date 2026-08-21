# groq-provider Specification

## Purpose

Ejecutar el agent loop contra Groq (modelo real gratuito) mediante su API compatible
con OpenAI, sin tocar la lógica de dominio, manteniendo el contrato `LlmProvider`.

## Requirements

### Requirement: Selección de provider por env

`LLM_PROVIDER=groq` SHALL construir un `OpenAICompatibleProvider` apuntando a
`GROQ_BASE_URL` (default `https://api.groq.com/openai/v1`) con modelo default
`GROQ_MODEL` (default `openai/gpt-oss-120b`). Si falta `GROQ_API_KEY`,
el arranque SHALL fallar con error claro.

#### Scenario: Factory construye provider groq

- GIVEN `LLM_PROVIDER=groq` y credenciales presentes
- WHEN el módulo LLM se inicializa
- THEN el token `LLM_PROVIDER` resuelve al OpenAICompatibleProvider configurado

#### Scenario: API key faltante

- GIVEN `LLM_PROVIDER=groq` sin `GROQ_API_KEY`
- WHEN el módulo se inicializa
- THEN falla con mensaje que nombre la variable faltante

### Requirement: Mapeo de mensajes y tool calls

El provider SHALL traducir el formato interno a chat.completions:
`role:'tool'` → `{ role:'tool', tool_call_id }`; assistant con `toolCalls` →
`tool_calls[].function.arguments` como JSON string; tools registradas → formato
`function`. Los arguments entrantes SHALL parsearse defensivamente (JSON string
u objeto) y un JSON inválido no SHALL romper el loop.

#### Scenario: Historial con resultado de tool se envía correctamente

- GIVEN un request cuyo historial incluye assistant+toolCalls y mensaje `role:'tool'`
- WHEN se llama complete()
- THEN el payload OpenAI contiene tool_calls serializados y el mensaje tool emparejado

### Requirement: Mapeo de respuesta

SHALL mapear `finish_reason`: `stop→end_turn`, `tool_calls→tool_use`,
`length→max_tokens`; usage desde `prompt_tokens/completion_tokens`; toolCalls
normalizadas a `{id,name,arguments(objeto)}`. Otros finish_reason → `stop_sequence`
conservando contenido.

#### Scenario: Respuesta con tool_calls se normaliza

- GIVEN una respuesta OpenAI con finish_reason tool_calls
- WHEN se normaliza
- THEN el LlmResponse expone stopReason 'tool_use' y arguments como objeto

### Requirement: Smoke test standalone

`pnpm run test:groq` SHALL ejecutar `scripts/groq-smoke.ts`: chat simple + tool call
delete_ticket sobre ticket temporal en DB local. El script SHALL excluirse de Jest/CI,
omitirse con aviso si no hay GROQ_API_KEY, y limpiar sus datos.

#### Scenario: Ejecución del smoke script

- GIVEN credenciales Groq válidas y stack local levantado
- WHEN se corre pnpm run test:groq
- THEN imprime respuesta del modelo, ejecuta/rechaza la tool y sale 0 con DB limpia

### Requirement: Providers existantes intactos

`LLM_PROVIDER=anthropic|fake` SHALL comportarse exactamente igual que hoy.

#### Scenario: Regresión de providers actuales

- GIVEN cualquier provider preexistente seleccionado
- WHEN corre la suite completa
- THEN 81 unit + 41 e2e permanecen en verde sin modificaciones a sus archivos
