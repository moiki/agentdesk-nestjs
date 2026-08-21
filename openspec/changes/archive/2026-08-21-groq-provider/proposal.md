# Proposal: groq-provider

## Why

El backend solo puede probarse contra el FakeLlmProvider (determinista) o Anthropic (de pago).
Para validar el agent loop completo —incluido el approval flow— contra un modelo real sin costo,
agregamos soporte Groq vía su API compatible con OpenAI.

## What Changes

- Nuevo `OpenAICompatibleProvider implements LlmProvider` (reutilizable para OpenAI, Groq, etc.)
- Selección por env `LLM_PROVIDER` (anthropic | fake | groq) + `GROQ_API_KEY`, `GROQ_BASE_URL`,
  `GROQ_MODEL`
- Script de humo standalone `scripts/groq-smoke.ts` (`pnpm run test:groq`) que NUNCA corre en CI
- Documentación README

## Capabilities

### New: groq-provider

Contrato de mapeo bidireccional entre el formato interno (provider-agnostic) y la API
compatible OpenAI: roles, tool_calls, finish_reason y usage.

## Impact

- `src/llm/`: nuevo provider + factory extendida
- `package.json`: dependencia `openai`, script `test:groq`
- Sin cambios en AgentService, tools ni rutas existentes
