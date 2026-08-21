# Design: groq-provider

## D1 — Reutilizar SDK `openai` (elegido) vs fetch manual

El SDK tipa chat.completions y tool_calls; apuntar `baseURL` a Groq es oficialmente
soportado. Fetch manual duplicaría serialización/errores. **Costo:** 1 dependencia
(~0 deps transitivas nuevas relevantes).

## D2 — Un provider genérico, no uno por vendor

`OpenAICompatibleProvider(client, defaultModel, defaultMaxTokens)` — OpenAI/Groq/
otros compatibles son solo configuración de factory. El nombre del provider reportado
(`name`) recibe el valor de `LLM_PROVIDER`.

## D3 — Tabla de mapeo (única fuente de verdad)

| Interno → OpenAI | OpenAI → Interno |
|---|---|
| `role:'tool'` + `toolCallId` | `{ role:'tool', tool_call_id }` |
| assistant.`toolCalls[]` | `tool_calls[].function.arguments` (JSON string) |
| tools registradas (`toJsonSchemaTools`) | `tools:[{type:'function',function:{...}}]` |
| — | `finish_reason`: stop→end_turn, tool_calls→tool_use, length→max_tokens, resto→stop_sequence |
| usage `{inputTokens,outputTokens}` | `prompt_tokens` / `completion_tokens` |

Arguments entrantes: `typeof === 'string' ? JSON.parse con catch → [] : ya objeto`.
JSON inválido ⇒ toolCalls vacías en la respuesta normalizada (el loop continúa,
no lanza).

## D4 — Smoke script standalone (NO spec Jest)

Razón: requiere red + credenciales reales; Jest/CI debe permanecer hermético.
`scripts/groq-smoke.ts` usa ts-node, crea tenant+ticket reales vía PrismaService,
corre 2 fases (/chat pausa → approve), limpia en finally y hace exit 1 si algo falla.
Sin key: aviso y exit 0 (no rompe pipelines locales).

## D5 — Factory

`llm.module.ts`: switch sobre ENV.LLM_PROVIDER con branches existentes intactos;
branch groq valida GROQ_API_KEY (throw temprano con nombre de variable).

## File Changes

| Archivo | Acción |
|---|---|
| package.json | + dep openai, + script test:groq |
| src/common/constants.ts | + LLM_PROVIDER, GROQ_* envs |
| src/llm/openai-compatible.provider.ts | NUEVO |
| src/llm/openai-compatible.provider.spec.ts | NUEVO (SDK mockeado) |
| src/llm/llm.module.ts | branch groq |
| scripts/groq-smoke.ts | NUEVO |
| README.md | tabla providers + sección Groq |
