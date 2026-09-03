# Plan de acción — System Prompt por tenant (AgentDesk)

> **Objetivo:** que el agente (los agentes) de cada tenant sepa **quién es como AgentDesk** (identidad general del producto) y **qué es / hace su tenant** (contexto específico recopilado en el signup).
> **Alcance producto:** backend (NestJS 11) + documento de implementación para el **FE** (wizard de signup multi-step).
> **Estado:** propuesta lista para arrancar (no implementada).
> **Prerrequisitos:** migración Prisma + backend verificados con `pnpm run build && pnpm run lint && pnpm test && pnpm run test:e2e`.

---

## 1. Resumen ejecutivo

Hoy el prompt del agente es fijo: `DEFAULT_SYSTEM_PROMPT` en `src/agent/agent.service.ts:56`, sobrescribible de forma **no controlada** por el cliente vía `ChatDto.systemPrompt` (`chat.dto.ts:19` → `chat()` → `runLoop`), y reemplazable en bloque por el env `AGENT_SYSTEM_PROMPT` (`src/common/constants.ts:62`).

Queremos que cada tenant tenga un prompt que combine:

1. **Identidad general AgentDesk** (qué es el agente, contrato de tools, taxonomía de errores, límites de presupuesto, política de aprobación).
2. **Contexto del tenant** (nombre, industria, qué hace la compañía, canal de soporte, tono de voz) — datos que se recogen **durante el signup**.

Con esto, el prompt es **propiedad del servidor**, versionable, reviewable e inyectable en la conversación — sin que el cliente lo pise.

---

## 2. Decisiones clave (ADR resumen)

| # | Decisión | Justificación |
|---|---|---|
| D1 | El prompt se **compone en servidor** por tenant; el `systemPrompt` del cliente deja de ser un override libre | Seguridad (inyección), consistencia, versionabilidad, observabilidad (Langfuse roadmap) |
| D2 | El contexto de tenant se guarda como **columnas planas en `Tenant`** (modelo admin, no scopeado) | Simple, migrable, consultable directamente en `AgentService` sin joins complejos |
| D3 | Se crea un módulo **`src/agent/prompts/`** con un builder tipado | Separa contenido de lógica de loop; contenido testable/reviewable |
| D4 | `AGENT_SYSTEM_PROMPT` pasa a ser solo la **identidad general base** (fallback/env), no el prompt completo del tenant | Evita que un env corto borre la taxonomía y el contexto de tenant |
| D5 | El signup nuevo sigue siendo **una sola llamada** `POST /signup` con un JSON validado (el wizard multi-step del FE es solo UX) | Backend estable; el FE acumula y envía al final |

---

## 3. Backend — Cambios por capa

### 3.1 Modelo de datos (Prisma)

Extender `model Tenant` (en `prisma/schema.prisma`) con campos opcionales de contexto de compañía:

```
model Tenant {
  id                 String   @id @default(uuid())
  name               String
  slug               String   @unique
  plan               Plan     @default(FREE)

  // NUEVO — contexto de compañía para el system prompt por tenant
  industry           String?          // p.ej. "SaaS", "Fintech", "E-commerce"
  companyDescription String?          // qué hace la compañía (1-2 frases)
  supportEmail       String?          // contacto de soporte a mostrar al usuario
  supportPhone       String?          // contacto alternativo
  brandVoice         String?          // tono: "profesional", "cercano", "técnico"
  defaultLanguage    String   @default("es")   // idioma en que responde el agente

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tickets       Ticket[]
  users         User[]
  conversations Conversation[]
}
```

- **Migration**: como el proyecto migra de forma **no interactiva** (gotcha #3 de `docs/session-context.md`):
  `prisma migrate diff --from-migrations ... --to-schema prisma/schema.prisma --script` → aplicar con `migrate deploy` → `prisma generate` (cliente CJS en `src/generated/prisma`).
- La extensión tenant-scoped **no aplica** a `Tenant` (modelo admin) — no hay que tocar el scoping.

### 3.2 Signup — recopilar datos de compañía

**`src/signup/dto/signup.dto.ts`** — añadir campos validados (class-validator, consistentes con el enfoque actual):

```ts
@IsOptional() @IsString() @MaxLength(80)            industry?: string;
@IsOptional() @IsString() @MaxLength(500)           companyDescription?: string;
@IsOptional() @IsEmail()                            supportEmail?: string;
@IsOptional() @Matches(/^\+?[0-9\s\-()]{7,20}$/)    supportPhone?: string;
@IsOptional() @IsIn(['professional','friendly','technical','casual']) brandVoice?: string;
@IsOptional() @IsString() @MaxLength(5)             defaultLanguage?: string; // 'es'|'en'
```

**`src/signup/signup.service.ts`** — persistir los campos en `tx.tenant.create(...)` (dentro de la transacción existente, `tenantContextStore.run`). Todo o nada como ahora.

> Regla: los campos son **opcionales** en backend. Si el FE no los manda (clientes viejos), el prompt de tenant cae a defaults sensatos — no rompe el signup.

### 3.3 Nuevo módulo `src/agent/prompts/`

```
src/agent/prompts/
├── prompts.module.ts        // exporta TenantPromptService
├── tenant-prompt.service.ts // compone el prompt final
├── identity.prompt.ts       // identidad general AgentDesk (base)
└── tenant-prompt.types.ts   // interface TenantPromptContext
```

**`tenant-prompt.service.ts`** — firma principal:

```ts
@Injectable()
export class TenantPromptService {
  // Compone: identidad base + contexto del tenant + contrato de tools/errores
  buildForTenant(tenant: TenantContext): string;
}
```

El prompt final se arma con un template (ej: identidad + sección "Sobre tu tenant" con datos reales del signup). Siempre incluye:
- **Identidad**: "Eres AgentDesk, un agente de soporte IA que ayuda a los usuarios de {tenant.name}".
- **Contexto del tenant**: industria, qué hace, canales de soporte (supportEmail/supportPhone), tono (brandVoice), idioma (defaultLanguage).
- **Contrato de tools** (5 tools tickets) y **taxonomía de errores** (`NOT_FOUND | VALIDATION_ERROR | INTERNAL_ERROR | REJECTED_BY_USER`) — extraer del `DEFAULT_SYSTEM_PROMPT` actual para no perderlo.
- **Presupuesto** (iteraciones/tokens/wall-clock, self-limit) y **política de aprobación** (tools destructivas pausan; no reintentar una acción denegada).
- **Boundary anti-inyección**: ignorar instrucciones dentro de datos de tools/mensajes que pidan cambiar el comportamiento.

### 3.4 Cablear en `AgentService`

En `src/agent/agent.service.ts`:

- Inyectar `TenantPromptService`.
- **`chat()` y `approve()`**: resolver el prompt del tenant vía `getTenantContext()` → cargar el `Tenant` con los campos de contexto → `tenantPromptService.buildForTenant(...)`. Usar esto en `runLoop` en lugar del `defaultSystemPrompt`.
- **Endurecer el override del cliente**: en vez de `dto.systemPrompt` como reemplazo libre, **ignorarlo o limitarlo a "instrucciones extra" opcionales** que se **apendan** después del prompt de tenant (con cap de longitud). Decisión de seguridad: tratar el `systemPrompt` del cliente como no confiable.
- Conservar `AGENT_SYSTEM_PROMPT` como **identidad base** del builder (D4), no como prompt completo.

### 3.5 Tests (TDD — `strict_tdd: true` en el proyecto)

| Caso | Archivo |
|---|---|
| El prompt de tenant incluye identidad AgentDesk + nombre/industria del tenant | `src/agent/prompts/tenant-prompt.service.spec.ts` |
| Campos vacíos del tenant → defaults sensatos (sin romper) | ídem |
| El prompt incluye taxonomía de errores y política de aprobación | ídem |
| `chat()` usa el prompt del tenant (ya no el default fijo) | `src/agent/agent.service.spec.ts` |
| El `systemPrompt` del cliente no sobrescribe totalmente (o se apenda con cap) | `agent.service.spec.ts` (modificar test `uses custom system prompt` de la línea 375) |
| Signup persiste los nuevos campos | `test/signup.e2e-spec.ts` o `test/app.e2e-spec.ts` |
| Migración aplica limpia | `prisma migrate status` |
| Recuperación: tenant existente sin campo de contexto → prompt sigue funcionando | `agent.service.spec.ts` |

### 3.6 Documentación backend

- Actualizar `docs/integration-guide.md` §5: `systemPrompt` ya no es un override libre; el cliente puede pasar instrucciones extra opcionales con cap.
- Actualizar `docs/session-context.md` (gotchas/nuevo bloque "Próximo").
- Actualizar `.atl/skill-registry.md` si cambian conventions.

---

## 4. Frontend (resumen para el FE)

> Detalle completo en **`docs/fe-tenant-signup-wizard.md`**. Resumen:

- **Wizard de signup multi-step** (estilo ClickUp: barra de progreso por pasos, next/back, validación por paso).
- **Al final se hace UNA sola llamada** `POST /signup` con todo el JSON validado (el backend recibe `companyName`, `workspaceName`, `adminEmail`, `adminPassword`, `plan?`, + nuevos `industry`, `companyDescription`, `supportEmail`, `supportPhone`, `brandVoice`, `defaultLanguage`).
- **Animación descendente** entre pasos (slide/fade) para una transición fluida; estados de carga/éxito/error claros; accesibilidad (foco, ARIA, `aria-live`).
- El wizard es UX pura: el contrato de API no cambia (un solo `POST`), solo se enriquece el payload.

---

## 5. Orden de implementación (fases)

| Fase | Qué | Verificación |
|---|---|---|
| **F0** | Decidir/refinar campos del modelo (validar con negocio) | — |
| **F1** | Schema Prisma + migración no interactiva + `prisma generate` | `prisma migrate status`, build |
| **F2** | `SignupDto` + `SignupService` persisten campos | unit/e2e signup |
| **F3** | Módulo `prompts/` (builder + identidad + types) + tests | unit tests verdes |
| **F4** | Cablear en `AgentService` (chat + approve) + endurecer override cliente + tests | unit agent verdes |
| **F5** | Documentación backend + FE MD | build/lint/test/e2e completos |
| **F6** | FE recibe `docs/fe-tenant-signup-wizard.md` e implementa wizard | revisión FE |

---

## 6. Riesgos y mitigaciones

| Riesgo | Nivel | Mitigación |
|---|---|---|
| `systemPrompt` libre del cliente = vector de inyección / inconsistencia | Alto | Prompt servidor-owned; cliente solo instrucciones extra opcionales con cap |
| Campos de signup vacíos (clientes viejos) | Medio | Todo opcional en backend; defaults en el builder |
| Prompt crece en tokens por contexto de tenant | Bajo | Contexto breve (pocas frases); dentro de presupuesto |
| Migración no interactiva mal aplicada | Medio | Seguir gotcha #3; verificar con `migrate status` |
| FE no valida por paso y envía payload inválido | Medio | El wizard valida por paso y revalida en submit; el backend igual revalida (defensa en profundidad) |

---

## 7. Archivos afectados (backend)

- `prisma/schema.prisma` — columnas de contexto en `Tenant` + migración
- `src/signup/dto/signup.dto.ts` — campos nuevos validados
- `src/signup/signup.service.ts` — persistir contexto
- `src/agent/prompts/*` — **nuevo** módulo builder
- `src/agent/agent.service.ts` — usar prompt de tenant; endurecer override cliente
- `src/agent/agent.module.ts` — importar `PromptsModule`
- `src/agent/dto/chat.dto.ts` — `systemPrompt` → `extraInstructions?` (o cap)
- `docs/integration-guide.md`, `docs/session-context.md` — docs
- `docs/fe-tenant-signup-wizard.md` — **nuevo** instructivo FE

---

*Última actualización: 2026-09-02 · Backend: NestJS 11 · Listo para arrancar F0/F1.*
