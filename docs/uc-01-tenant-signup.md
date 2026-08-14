# UC-01 — Onboarding de un tenant (self-service signup)

> **Estado:** borrador · **Cambio clave:** el alta del tenant **ya no es provisionamiento por admin**.
> Es un flujo self-service estilo SaaS: el tenant se registra solo (`signup`) y recibe sus credenciales.

---

## 1. Contexto y por qué cambia el diseño anterior

Antes se asumía que un operador de la plataforma daba de alta a cada tenant vía
`POST /tenants` (endpoint admin) y le entregaba el UUID a mano. Eso bloquea la
escala y complica el demo/onboarding. El nuevo modelo:

- Cualquier empresa puede **crear su propio espacio** (tenant) con un formulario de signup.
- Recibe inmediatamente su **tenantId (UUID)** + credenciales del **admin del tenant**.
- A partir de ahí usa el sistema con **autenticación propia** (JWT), sin depender
  de un header confiable por el cliente.

Esto implica que la identidad deja de provenir de un header `x-tenant-id` del
cliente y pasa a derivarse del **token autenticado** (ver §6).

---

## 2. Actores

| Actor | Descripción |
|---|---|
| **Prospecto / Admin del tenant** | Persona que crea el espacio de su empresa. Primer usuario (rol `ADMIN`). |
| **Sistema AgentDesk** | Gateway: API, auth, scoping de datos. |
| **Operador de la plataforma** | Dueño del deployment. Ya no crea tenants; solo soporte/supervisión. *(fuera de este UC)* |

---

## 3. Objetivo

Que una empresa cree su espacio (tenant) **sin intervención humana**, reciba
credenciales y pueda operar sus tickets y (futuro) su agente con datos aislados.

---

## 4. Precondiciones

- Sistema desplegado y saludable (`GET /health` OK).
- Endpoint público `POST /signup` disponible (sin auth).
- BD disponible (transacción para Tenant + User admin).

---

## 5. Flujo principal (happy path)

```
Prospecto               API /signup                 BD                Login / API
   │   POST /signup       │                          │                    │
   ├─────────────────────►│  { companyName,          │                    │
   │                      │    workspaceName,        │                    │
   │                      │    adminEmail,           │                    │
   │                      │    adminPassword,        │                    │
   │                      │    plan?: FREE }         │                    │
   │                      │  ── transacción ──►      │                    │
   │                      │  1. create Tenant(id: uuid)                   │
   │                      │  2. create User(admin, tenantId)              │
   │                      │  ── commit ──►           │                    │
   │  201 { tenantId,     │◄─────────────────────────│                    │
   │       adminUserId,   │                          │                    │
   │       plan }         │                          │                    │
   ├◄─────────────────────┤                          │                    │
   │                      │                          │                    │
   │  POST /auth/login    │                          │                    │
   ├─────────────────────►│  { email, password }     │                    │
   │                      │  → bcrypt.compare        │                    │
   │  200 { accessToken } │◄─────────────────────────│                    │
   ├◄─────────────────────┤                          │                    │
   │  (con token) POST /tickets   →  contexto: tenantId = token.subject    │
   │  GET /tickets ...    │   Middleware: valida JWT → AsyncLocalStorage   │
   │                      │   Prisma scoped por tenantId del token         │
```

**Pasos textuales:**

1. El prospecto completa el formulario de signup: nombre de empresa,
   nombre de espacio, email del admin, contraseña, plan (FREE por defecto).
2. El sistema valida el input (email único y bien formado, contraseña ≥ 8 chars,
   nombres no vacíos, plan válido).
3. En **una transacción**: crea el `Tenant` y el `User` admin (hash de la contraseña).
4. Devuelve `201` con `{ tenantId, adminUserId, plan }`.
5. El admin inicia sesión: `POST /auth/login` → `200` con `accessToken` (JWT).
6. El JWT contiene `userId` y `tenantId`. El middleware lee la identidad **del token**,
   bindea `AsyncLocalStorage` y el resto de la app opera scoped (tickets, futuro agente).

---

## 6. Flujos alternativos y excepciones

| # | Caso | Respuesta |
|---|---|---|
| A1 | `adminEmail` ya registrado | `409 Conflict` — "email ya registrado", sugerir login. |
| A2 | Contraseña < 8 chars / débil | `400` con detalle de validación. |
| A3 | `plan` inválido | `400` — solo `FREE` para self-service MVP. |
| A4 | Fallo en mitad de la transacción (p.ej. duplicado de workspaceName) | Rollback: ni tenant ni user quedan creados (no hay estado parcial). |
| A5 | Login con email/contraseña incorrectos | `401` genérico (no revela cuál falló). |
| A6 | Token expirado / inválido | `401` — el FE re-autentica (refresh token en fase posterior). |
| A7 | Tenant dado de baja / plan vencido | `403` al usar el sistema (regla de negocio futura). |

---

## 7. Postcondiciones

- Existe un `Tenant` activo con su UUID.
- Existe un `User` admin con `role=ADMIN`, `passwordHash` (nunca texto plano).
- El admin puede autenticarse y operar tickets dentro de su tenant.
- Ningún dato del nuevo tenant es visible para otros tenants (scoping garantizado).

---

## 8. Reglas de negocio

1. **Self-service**: el alta no requiere aprobación humana.
2. **1 email = 1 user**; un email no puede repetirse entre tenants.
3. **El primer user de un tenant es `ADMIN`**; los invites (member) quedan fuera del MVP.
4. **`tenantId` deriva del token autenticado**, nunca del body ni confiando en el header del cliente.
5. **Plan**: `FREE` seleccionable; `PRO`/`ENTERPRISE` requieren billing (fuera de alcance MVP).
6. **Atomicidad**: Tenant + admin User se crean juntos (transacción).

---

## 9. Impacto en la arquitectura actual

### Nuevo
- **Modelo `User`** (tenant-owned, scoped como `Ticket`): `id`, `tenantId`,
  `email` (único), `passwordHash`, `role` (`ADMIN`|`MEMBER`), timestamps.
- **Endpoint público** `POST /signup` (reemplaza al concepto de `POST /tenants` admin).
- **Auth**: `POST /auth/login` → JWT (`userId` + `tenantId` como claims).
  Hashing con `bcrypt` (o `argon2`).
- **Middleware de auth**: valida JWT → setea `tenantId` en `AsyncLocalStorage`.
  Sustituye la confianza en el header `x-tenant-id`.

### Cambios
- `POST /tenants` deja de ser el camino de alta real (puede permanecer solo como
  utilidad de operador/seed de dev, o eliminarse).
- El `TenantContextMiddleware` pasa a leer el `tenantId` **del token autenticado**
  en vez del header del cliente (el header queda opcional solo para clientes
  máquina / dev, nunca como fuente de confianza).
- El signup es el **único endpoint sin auth**: todo lo demás exige JWT.

### Sin cambio
- Scoping Prisma, `ADMIN_MODELS = { Tenant }`, AsyncLocalStorage, tests de
  aislamiento, capa LLM.

---

## 10. Criterios de aceptación (testeables)

1. `POST /signup` válido → `201` con `tenantId`, `adminUserId`, `plan`; y en BD
   existen `Tenant` + `User` admin con hash.
2. `POST /signup` con email duplicado → `409` y **no** se crea tenant ni user.
3. Fallo transaccional → estado consistente (sin tenant sin user, ni al revés).
4. `POST /auth/login` correcto → `200` con JWT; incorrecto → `401`.
5. Con el token del tenant A, `GET /tickets` solo devuelve tickets de A.
6. Con el token de A, `GET /tickets/:id` de un ticket de B → `404`.
7. `POST /tickets` sin token → `401`; con token cuyo tenant está inactivo → `403`.
8. El hash de la contraseña nunca aparece en respuestas ni logs.

---

## 11. Decisiones abiertas (antes de implementar)

| Decisión | Resolución (SPC-01) | Impacto si cambia |
|---|---|---|
| ¿Verificación de email en el signup? | **Abierta** — no para MVP (reducir fricción) | Añade servicio de email + token de verificación. |
| ¿Refresh tokens / expiración? | JWT de corta duración (`JWT_EXPIRES_IN`, default `1h`); refresh en fase posterior | Solo afecta UX de sesión. |
| ¿Se conserva `POST /tenants` admin? | **Eliminado** — onboarding self-service vía `POST /signup` | Seed de dev si se necesitara. |
| ¿Header `x-tenant-id` se elimina? | Se elimina como fuente de confianza; el tenant se deriva del JWT. Fallback dev `ALLOW_TENANT_HEADER=true` | Clientes máquina deberán usar JWT de servicio (fase posterior). |
| ¿Modo de interacción con el agente (chat libre vs accionadores)? | **Abierta** — chat libre para el MVP | Define forma del endpoint `/assist`. |

---

## 12. Fuera de alcance del MVP

- Invitaciones/multi-usuario (`MEMBER`).
- Billing/planes pagos (Stripe) y `PRO`/`ENTERPRISE`.
- Verificación de email y password recovery.
- OAuth/SSO.
- Refresh tokens y scopes de API-key por servicio.
- Onboarding asistido (wizard) del primer agente.
