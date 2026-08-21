# Apply Progress — approval-flow

**Estado:** COMPLETO · 17/17 tareas · 3 work units · 3 commits en main

## Work Units
| WU | Tasks | Commit | Contenido |
|---|---|---|---|
| 1 | 1.1–1.2, 2.1–2.4 | `43bbd71` | `awaitingApproval`, `REJECTED_BY_USER`, refactor `runLoop()`, partición 3-vía |
| 2 | 3.1–3.6 | feat(agent): POST /chat/approve resume endpoint | DTOs, ruta, validaciones, materialización, eventos |
| 3 | 4.1–4.3, 5.1–5.2 | test(e2e)+docs: approval flow acceptance suite and FE contract | e2e suite, docs/spec-02, README |

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|---|---|---|---|---|---|---|---|
| 1.1–1.2 | agent.service.spec.ts | Unit (types) | ✅ 14/14 | ➖ estructural | ✅ vía 2.1 | ➖ type-only | ✅ |
| 2.1 | `exposes awaitingApproval…` | Unit | ✅ 14/14 | ✅ TS-fail | ✅ 15/15 | ✅ tools-normales | ✅ |
| 2.2 | suite existente | Unit | ✅ 15/15 | N/A refactor | ✅ 15/15 | N/A | ✅ preservado |
| 2.3–2.4 | `mixed batch…` | Unit | ✅ 15/15 | ✅ 1 failed | ✅ 16/16 | ✅ pausa pura+mixto | ➖ |
| 3.2–3.3 | 4 casos `400…` | Unit | ✅ 16/16 | ✅ 4 failed | ✅ 20/20 | ✅ 5 caminos | ➖ |
| 3.4–3.5 | ciclo B (4 casos) | Unit | ✅ 20/20 | ⚠️ ya cubierta por impl. A | ✅ 24/24 | ✅ approve/reject/eventos/re-pausa | ➖ |
| 3.1+3.6 | e2e pipe real | E2E | ✅ build | ➖ estructural | ✅ e2e | ✅ pipe 400s | ➖ |
| 4.1–4.3 | agent-approval.e2e-spec.ts | E2E | ✅ 33/33 | ➖ aceptación | ✅ 6/6 | ✅ 6 escenarios HTTP | ➖ |

## Issues durante apply
- Import faltante `BadRequestException` detectado por run RED (WU2). Fix inmediato.
- Desviación documentada: detección de pending = *unanswered toolCalls* (no "último mensaje assistant") para soportar batches mixtos.
- Infra fuera de alcance: `docker compose up` falla construyendo servicio `app` (`pnpm-lock.yaml` no llega al build; sospecha `.dockerignore`). Postgres/Redis individuales OK.
