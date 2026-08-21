# Apply Progress — groq-provider

**Estado:** COMPLETO · 11/11 tareas · 1 unidad única (`size:exception` aprobada)

## TDD Cycle Evidence

| Task | Test | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|---|---|---|---|---|---|---|---|
| 1.1–1.2 deps+env | — (config) | — | ✅ 81/81 | ➖ estructural | ✅ build+suite | ➖ config-only | N/A |
| 2.1–2.2 mapeo saliente | `maps system, tool-result pairing…` + `omits tools…` | Unit (SDK mockeado) | ✅ 81/81 | ✅ module-not-found | ✅ 8/8 | ✅ con/sin tools | ➖ |
| 2.3 mapeo respuesta | 4 casos (tool_calls, finish_reason ×3, args inválidos, args objeto) | Unit | ✅ 81/88 | ✅ (mismo ciclo RED) | ✅ 8/8 | ✅ 3 finish_reason + edge JSON | ✅ parseArguments extraído |
| 3.1 factory groq | `fails fast naming GROQ_API_KEY` etc. ×3 | Unit | ✅ 89/89 | ✅ 3 failed | ✅ 92/92 | ✅ error/wiring/regresión fake+anthropic | ✅ `createLlmProvider()` exportada |
| 4.1–4.2 smoke real | ejecución manual contra API Groq | E2E manual | ✅ build | ➖ aceptación | ✅ PASS | ✅ pausa→approve→end_turn | N/A |
| 5.1–5.2 docs+regresión | suite completa | — | — | — | ✅ 92 unit / 41 e2e | — | — |

**Final: 92/92 unit · 41/41 e2e · build ✅ · lint ✅**

## Issues encontrados durante apply

1. **Modelo Groq deprecado**: `llama-3.3-70b-versatile` ya no existe en el catálogo
   2026 → default cambiado a `openai/gpt-oss-120b` (verificado vía `/v1/models`).
   Documentar en README para futuros cambios de catálogo.
2. **tsx/esbuild no sirve para bootstrap Nest**: esbuild no emite
   `design:paramtypes` completo → Nest inyecta `undefined` en
   `TenantScopedPrismaService`. Solución: script vive en `src/scripts/`, se
   compila con `nest build` y corre con `node dist/scripts/groq-smoke.js`
   (metadata tsc completa). No usar tsx para entrypoints Nest.
3. **cross-env y `&&`**: `cross-env VAR=x cmd1 && cmd2` solo aplica VAR a cmd1.
4. **Prisma client generado** importa con extensión `.js` (nodenext): Jest lo
   mapea vía moduleNameMapper; ts-node CJS falla. Otra razón para el approach dist.
5. **Decisión de diseño emergente**: el modelo del provider es autoritativo
   (`this.defaultModel || request.model`) porque el loop siempre envía
   `ENV.LLM_MODEL` (claude); así GROQ_MODEL gana sin tocar el dominio.

## Ejecución real Groq (task 4.2)

```
⏸️ Phase 1 stopReason: tool_use
⏸️ Pending call: delete_ticket { ticketId }
▶️ Phase 2 stopReason: end_turn
🔧 toolResults[0].success: true
✅ Groq smoke passed — real model, real tools, clean DB
```
