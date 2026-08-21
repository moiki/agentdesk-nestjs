# Skill Registry — AgentDesk (ai-nestjs-test-1)

> Generado por sdd-init. Re-crear con el skill `skill-registry` tras instalar/quitar skills.
> El orquestador resuelve reglas compactas leyendo los SKILL.md relevantes antes de delegar.

## Project Context

- Stack: NestJS 11 · Prisma 7 · Postgres/Redis (Docker) · Zod 4 · Jest (unit + e2e supertest) · pnpm
- Convenciones del proyecto: sin CLAUDE.md/AGENTS.md en raíz. Fuente de verdad: README.md + docs/session-context.md (gotchas #1-#21) + docs/spec-01-tenant-signup-auth.md.
- Comando de verificación: `pnpm run build && pnpm run lint && pnpm test && pnpm run test:e2e`

## User Skills — Trigger Table

| Skill | Trigger | Ubicación | Relevancia proyecto |
|---|---|---|---|
| nestjs-best-practices | Escribir/revisar/refactorizar código NestJS (módulos, DI, guards, seguridad, performance) | ~/.agents/skills/nestjs-best-practices/SKILL.md | **ALTA — inyectar siempre en fases apply/verify** |
| work-unit-commits | Implementar cambios, preparar commits, dividir PRs | ~/.claude/skills/work-unit-commits/SKILL.md | ALTA en fase apply |
| gentle-ai-chained-pr | Cambio > 400 líneas; PRs encadenados/apilados | ~/.claude/skills/chained-pr/SKILL.md | ALTA si forecast excede presupuesto |
| branch-pr | Crear pull request / preparar changes para review | ~/.claude/skills/branch-pr/SKILL.md | MEDIA al cerrar cada change |
| code-review | "review PR", revisar pull request, aprobar | ~/.claude/skills/code-review/SKILL.md | Media post-verify |
| judgment-day | "judgment day", doble review adversario | ~/.claude/skills/judgment-day/SKILL.md | Opcional |
| cognitive-doc-design | Escribir guías/READMEs/docs de arquitectura | ~/.claude/skills/cognitive-doc-design/SKILL.md | Media en docs de change |
| issue-creation | Crear issue de GitHub / reportar bug | ~/.claude/skills/issue-creation/SKILL.md | Baja |
| comment-writer | Redactar comentarios PR/issues/chat | ~/.claude/skills/comment-writer/SKILL.md | Baja |
| sync-to-notion | "sync to notion", publicar resumen a Notion | ~/.claude/skills/sync-to-notion/SKILL.md | Baja |
| daily-update-clickup | Standup diario en tarea ClickUp | ~/.claude/skills/daily-update-clickup/SKILL.md | N/A |
| skill-creator | Crear skills nuevas | ~/.claude/skills/skill-creator/SKILL.md | Baja |
| find-skills | Descubrir skills instalables | ~/.claude/skills/find-skills/SKILL.md | Baja |
| audit-mongo-leaks | Auditoría MongoDB multi-tenant | ~/.claude/skills/audit-mongo-leaks/SKILL.md | N/A (este proyecto usa Postgres) |
| mongo-pipeline-qa | QA de agregaciones MongoDB | ~/.claude/skills/mongo-pipeline-qa/SKILL.md | N/A |
| migrate-mrr-fixes | Migrar fixes MRR a GrowthOptix | ~/.claude/skills/migrate-mrr-fixes/SKILL.md | N/A |
| dotnet-teacher / golang-teacher / go-testing / dotnet-cleanarch* | Enseñanza .NET/Go, tests Go | ~/.claude/skills/*/SKILL.md | N/A |

\* dotnet-cleanarch existe en disco pero sin entrada en available_skills; tratar como N/A.

## Compact Rules — nestjs-best-practices (resumen operativo)

> Extraer el detalle desde el SKILL.md al delegar apply/verify. Reglas mínimas conocidas:
- Módulos por dominio con `exports` explícitos de servicios compartidos (gotcha #9 del proyecto).
- Identidad/tenant SIEMPRE del JWT vía middleware; nunca del body ni headers custom.
- DTOs con class-validator estricto (`whitelist` + `forbidNonWhitelisted` ya globales).
- Inyección por token para providers intercambiables (patrón `LLM_PROVIDER`).

## Compact Rules — verificación (obligatoria en verify)

```bash
pnpm run build && pnpm run lint && pnpm test && pnpm run test:e2e
```
