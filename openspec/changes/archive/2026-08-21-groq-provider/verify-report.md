# Verify Report — groq-provider

**Change:** groq-provider · **Spec:** groq-provider v1 · **Modo:** Strict TDD
**Ejecutado:** 2026-08-21

---

## Completeness
| Métrica | Valor |
|---|---|
| Tareas totales | 11 |
| Completas | 11 |
| Incompletas | 0 |

## Build & Tests (ejecución fresca)
| Check | Resultado |
|---|---|
| `pnpm run build` | ✅ exit 0 |
| `pnpm run lint` | ✅ limpio |
| Unit `pnpm run test:cov` | ✅ **92/92**, 9 suites |
| E2E `pnpm run test:e2e` | ✅ **41/41**, 6 suites |

## TDD Compliance
| Check | Result | Details |
|---|---|---|
| Evidencia TDD reportada | ✅ | apply-progress.md, tabla de 6 filas |
| Todas las tareas con tests | ✅ | 11/11 (config validado vía build+suite) |
| RED confirmado | ✅ | module-not-found ×8 · 3 failed factory |
| GREEN confirmado (pasan ahora) | ✅ | 92+41 en ejecución fresca |
| Triangulación adecuada | ✅ | finish_reason ×3, args string/objeto/roto, con/sin tools |
| Safety net | ✅ | 81→92 unit sin regresión; providers previos intactos |

Nota de auditoría: los "3 failed" del RED de 3.1 son el ciclo esperado (tests antes que implementación). Hubo además 2 fallos transitorios de arnés (`openai` no instalado realmente; `jest.spyOn` sobre propiedad plana) resueltos antes del GREEN final — documentados en apply-progress.

## Test Layer Distribution
| Layer | Tests | Files | Tools |
|---|---|---|---|
| Unit | 14 nuevos / 92 total | openai-compatible.provider.spec.ts (8) · llm.module.spec.ts (3) · existentes | Jest + ts-jest |
| Integration | — | — | no aplica |
| E2E manual | 1 corrida real | src/scripts/groq-smoke.ts | API Groq real + Prisma local |
| E2E automatizada | 41 (regresión) | suites existentes | Supertest |

## Changed File Coverage
| File | Line % | Branch % | Uncovered Lines | Rating |
|---|---|---|---|---|
| `src/llm/openai-compatible.provider.ts` | 97.5% | 82.5% | L140 (`{ value: parsed }` para JSON primitivo) | ✅ Excellent |
| `src/llm/llm.module.ts` | 90% | 87.5% | L21 (throw anthropic sin key, preexistente) · L50 (wrapper useFactory) | ⚠️ Acceptable |
| `src/common/constants.ts` | n/a | — | envs declarativos | ℹ️ Config |

Providers existentes (regresión): anthropic 90.62% / fake 95.23% — idénticos al baseline.

## Assertion Quality
✅ All assertions verify real behavior. Payloads completos verificados (messages[], tool_calls serializados, pairing tool_call_id, function schemas, max_tokens/model). Sin tautologías, ghost loops ni mock-heaviness (1 cliente mockeado por test, ≥3 asserts).

## Spec Compliance Matrix

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Selección de provider por env | Factory construye provider groq | unit `builds an OpenAICompatibleProvider named "groq"` + boot real de AppModule en smoke | ✅ COMPLIANT |
| Selección de provider por env | API key faltante | unit `fails fast naming GROQ_API_KEY` (mensaje nombra la variable) | ✅ COMPLIANT |
| Mapeo de mensajes y tool calls | Historial con tool result se envía correctamente | unit `maps system, tool-result pairing and function tools…` (+`omits tools`) | ✅ COMPLIANT |
| Mapeo de respuesta | Respuesta con tool_calls normalizada | unit normalize (stopReason, arguments objeto, usage, model) + finish_reason stop/length/content_filter + args roto/objeto | ✅ COMPLIANT |
| Smoke test standalone | Ejecución del smoke script | corrida manual PASS contra API real (pausa→approve→delete una vez→end_turn, DB limpia); excluido de Jest/CI por diseño D4 | ✅ COMPLIANT (manual) |
| Providers existantes intactos | Regresión de providers actuales | 92 unit + 41 e2e verdes; diff solo aditivo en llm.module.ts, archivos anthropic/fake sin cambios | ✅ COMPLIANT |

**Compliance summary:** 6/6 escenarios compliant

## Coherence (Design)
| Decisión | ¿Seguida? | Notas |
|---|---|---|
| D1 SDK `openai` reutilizado | ✅ | baseURL apunta a Groq |
| D2 Provider genérico + nombre configurable | ✅ | `name='groq'` vía factory |
| D3 Tabla de mapeo única | ✅ | roles/tool_calls/finish_reason/usage según tabla |
| D4 Script standalone fuera de Jest/CI | ⚠️ Deviated→justificado | ubicación final `src/scripts/` compilado a `dist/` (tsx/esbuild no emite metadata DI de Nest; ts-node CJS no resuelve imports `.js` del cliente Prisma generado) |
| D5 Factory con validación temprana | ✅ | throw nombra `GROQ_API_KEY` |

Decisión emergente documentada: modelo del provider autoritativo
(`this.defaultModel || request.model`) — GROQ_MODEL gana sobre ENV.LLM_MODEL sin tocar dominio. Default actualizado `openai/gpt-oss-120b` (catálogo Groq 2026; llama-3.3-70b-versatile deprecado).

## Issues Found

**CRITICAL:** None

**WARNING:** None

**SUGGESTION:**
1. Caso para JSON primitivo en arguments (`"42"` → `{value:42}`) hoy sin test (L140).
2. Throw de anthropic-sin-key quedó sin cobertura tras extracción (comportamiento preexistente).
3. Higiene histórica del repo: `coverage/` estaba trackeado — des-indexado hoy en commit separado.

## Verdict
**PASS** — 6/6 escenarios compliant, ejecución real contra Groq exitosa, cero regresiones, sin CRITICAL ni WARNING.
