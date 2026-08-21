# Tasks: groq-provider

## Phase 1 — Deps y configuración
- [x] 1.1 Instalar `openai` (pnpm add openai)
- [x] 1.2 ENV: `LLM_PROVIDER`, `GROQ_API_KEY`, `GROQ_BASE_URL`, `GROQ_MODEL` en constants.ts con defaults

## Phase 2 — Provider (TDD estricto)
- [x] 2.1 RED: spec de mapeo saliente (historial con assistant+toolCalls y role:'tool' → payload OpenAI correcto; tools en formato function)
- [x] 2.2 GREEN: implementar `buildMessages()`/`buildTools()` en OpenAICompatibleProvider
- [x] 2.3 RED→GREEN: mapeo de respuesta (finish_reason→stopReason, usage, toolCalls normalizadas, arguments JSON-string defensivo)
- [x] 2.4 REFACTOR: extraer helpers puros si aplica

## Phase 3 — Factory
- [x] 3.1 Branch groq en llm.module.ts (validación GROQ_API_KEY temprana) + unit del error de key faltante

## Phase 4 — Smoke script
- [x] 4.1 scripts/groq-smoke.ts standalone (fase pausa + approve + cleanup finally + exit codes) y script `test:groq`
- [x] 4.2 Ejecución manual real contra Groq (credenciales del usuario) — evidencia en apply-progress

## Phase 5 — Docs y cierre
- [x] 5.1 README: providers soportados + cómo activar Groq
- [x] 5.2 Suite completa verde sin tocar providers existentes (81 unit + 41 e2e)
