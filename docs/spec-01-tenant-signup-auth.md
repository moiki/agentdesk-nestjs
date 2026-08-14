# SPC-01 — Signup self-service + Autenticación (JWT)

> **Estado:** spec de implementación · **Base:** `docs/uc-01-tenant-signup.md`
> **Objetivo:** convertir el alta de tenants en self-service (signup) y proteger
> la API con JWT, derivando la identidad del tenant del token en vez del header.

---

## 1. Contexto

Hoy la API confía en el header `x-tenant-id` (Fase 1). Con self-service la
identidad debe provenir de un **token autenticado**. Esta spec cierra el ciclo:
signup público → login → JWT → middleware de contexto leyendo el token → todo
scoping existente se conserva sin cambios.

---

## 2. Requisitos funcionales

| ID | Requisito |
|---|---|
| FR-01 | `POST /signup` público (sin auth) crea `Tenant` + `User` admin en **una transacción**. |
| FR-02 | Signup devuelve `201` con `{ tenantId, adminUserId, plan }`; nunca devuelve el hash. |
| FR-03 | Email único a nivel global; duplicado → `409`, sin estado parcial. |
| FR-04 | `POST /auth/login` (email+password) → `200 { accessToken }`; fallo → `401` genérico. |
| FR-05 | JWT contiene `sub` (userId), `tenantId`, `role`, `iat`, `exp`. |
| FR-06 | Todo endpoint excepto `/health`, `/signup`, `/auth/login` exige `Authorization: Bearer <jwt>`; sin token → `401`. |
| FR-07 | El `tenantId` del contexto sale **del token**, no del header ni del body. |
| FR-08 | `GET /auth/me` devuelve `{ userId, tenantId, email, role, tenantName, plan }` (bootstrap del FE). |
| FR-09 | El aislamiento multi-tenant se preserva idéntico (scoping Prisma + AsyncLocalStorage). |
| FR-10 | Tokens: `exp` configurable (`JWT_EXPIRES_IN`), default `1h`; refresco fuera de MVP. |

## 3. Requisitos no funcionales

| ID | Requisito |
|---|---|
| NFR-01 | Hashing de password con `bcryptjs` (cost 10+). Nunca en texto plano ni en logs/respuestas. |
| NFR-02 | `JWT_SECRET` desde env; requerido en prod (throw en boot si falta y `NODE_ENV=production`). |
| NFR-03 | Rate limiting en `/signup` y `/auth/login` (`@nestjs/throttler`, p.ej. 5/min por IP en login). |
| NFR-04 | Validación estricta de input (ValidationPipe global ya activo): `whitelist` + `forbidNonWhitelisted`. |
| NFR-05 | `401` de login no revela si falló el email o la contraseña. |
| NFR-06 | La verificación del tenant existe **en login**; la re-validación por request queda fuera (perf). |
| NFR-07 | (Opcional dev) `ALLOW_TENANT_HEADER=true` permite el header legacy solo en entornos no-prod. |

---

## 4. Modelo de datos

```prisma
enum UserRole {
  ADMIN
  MEMBER
}

model User {
  id           String   @id @default(uuid())
  tenantId     String
  email        String   @unique
  passwordHash String
  role         UserRole @default(ADMIN)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  tenant       Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
}
```

- `Tenant` gana la relación `users User[]`.
- `User` es **tenant-owned**: queda dentro del scoping de la extensión Prisma
  (se le inyecta `tenantId` como a `Ticket`). `Tenant` sigue en `ADMIN_MODELS`.
- Migración nueva (ej. `20260814_signup_auth`).

### Detalle clave de implementación (gotcha)

El signup ocurre **sin contexto de tenant** (aún no existe). Para que la
extensión scoped inyecte `tenantId` en `User` correctamente:

1. Generar `tenantId = randomUUID()` en el servicio.
2. `scopedPrisma.$transaction(async (tx) => { ... })`.
3. Crear `Tenant` con ese id (permitido: modelo admin).
4. Crear el `User` **dentro de** `tenantContextStore.run({ tenantId }, () => tx.user.create(...))`
   — la extensión lee el tenantId del ALS y lo sella.

Así no hace falta ningún bypass "unscoped" ni duplicar la lógica de scoping.

---

## 5. Contrato de API

### `POST /signup` (público)

```jsonc
// Request
{
  "companyName": "Acme Inc",          // string, 1..120
  "workspaceName": "acme",            // string, 3..40, slug
  "adminEmail": "ops@acme.com",       // email válido
  "adminPassword": "secret123",       // min 8
  "plan": "FREE"                      // opcional, default FREE; solo FREE en MVP
}

// 201 Created
{
  "tenantId": "f47ac10b-...",
  "adminUserId": "9b2f...",
  "plan": "FREE"
}

// 400 Validation failed (detalle de campos)
// 409 Email already registered (sin crear nada)
```

### `POST /auth/login` (público)

```jsonc
// Request
{ "email": "ops@acme.com", "password": "secret123" }

// 200
{ "accessToken": "<jwt>" }

// 401 Invalid credentials
```

### `GET /auth/me` (auth)

```jsonc
// 200
{
  "userId": "9b2f...",
  "tenantId": "f47ac10b-...",
  "email": "ops@acme.com",
  "role": "ADMIN",
  "tenantName": "Acme Inc",
  "plan": "FREE"
}
```

### Códigos de error comunes

- `401` — token faltante, inválido o expirado.
- `400` — input inválido.
- `409` — email duplicado.
- Envelope por defecto de NestJS (`{ statusCode, message, error }`).

---

## 6. Arquitectura (módulos)

```
src/
  auth/
    auth.module.ts          # JwtModule (JwtService), guard, strategy ligera
    auth.controller.ts      # POST /auth/login · GET /auth/me
    auth.service.ts         # login: buscar user → bcrypt.compare → firmar JWT
    jwt-auth.guard.ts       # guard global: valida Bearer + @Public() opt-out
    public.decorator.ts     # @Public() para /health /signup /auth/login
  signup/
    signup.module.ts        # orquesta onboarding (depende de prisma + users)
    signup.controller.ts    # POST /signup
    signup.service.ts       # transacción Tenant+User con seeding de ALS (§4)
  users/
    users.module.ts         # servicio scoped (futuro: invites, /users)
    users.service.ts        # findUserByEmail (login), etc.
  tenancy/
    tenant-context.middleware.ts   # CAMBIA: lee tenantId del token validado
                                   # (ya no confía en x-tenant-id)
    tenant-context.ts              # sin cambios (ALS)
    tenant-scoped.prisma.ts        # sin cambios
```

**Decisiones de diseño:**

- **Sin passport** — se usa `@nestjs/jwt` (`JwtService`) con un `JwtAuthGuard`
  custom: menos dependencias y piezas móviles que passport+strategy.
- **Guards + middleware**: el guard global ejecuta la autenticación (verifica
  firma/expiración, setea `req.user = { userId, tenantId, role }`); el middleware
  de contexto bindea el `tenantId` a `AsyncLocalStorage`. Orden NestJS:
  middleware → guard → controller, así el middleware ya encuentra `req.user`.
- `@Public()` marca `/health`, `/signup`, `/auth/login`. Todo lo demás cae en
  el guard → `401`.
- `POST /tenants` (admin) queda **retirado** del flujo de alta; opcional como
  seed de dev bajo env `ENABLE_ADMIN_SEED=true`.

### Middleware (cambio central)

Antes: leía `x-tenant-id` → validaba tenant → ALS.
Ahora: `req.user` ya trae `tenantId` (seteado por el guard) → `tenantContextStore.run(req.user)`.
El header `x-tenant-id` **deja de ser fuente de confianza** (dev-only via
`ALLOW_TENANT_HEADER=true`, nunca en prod).

---

## 7. Plan de pruebas

### Unit
1. `AuthService.login`: éxito → JWT con claims correctos; password erróneo → throw `401`;
   user inexistente → `401` (mismo mensaje); hash nunca expuesto.
2. `SignupService.signup`: crea tenant+user en transacción; email duplicado → `409`
   y **no** crea nada (rollback); valida plan `FREE`; genera `tenantId` y lo sella
   correctamente en `User` (assert contra un cliente scoped).
3. `JwtAuthGuard`: token válido → pasa; expirado → `401`; sin header → `401`; `@Public()` → pasa.

### e2e (reemplaza/aumenta `tenant-isolation.e2e-spec.ts`)
1. Signup → login → crear tickets con token → OK.
2. **Aislamiento A/B con tokens**: user de tenant A no ve tickets de B; `GET /tickets/:id`
   de B desde A → `404`; `POST /tickets` de A solo crea en A.
3. Signup email duplicado → `409` y BD sin estado parcial (cuenta tenants/users).
4. Login incorrecto → `401`; login correcto → token usable en `/auth/me`.
5. Sin token → `401` en `/tickets` y `/auth/me`; `/health` y `/signup` siguen públicos.
6. Token firmado con otro secret / expirado → `401`.
7. El body de respuestas/logs nunca contiene `passwordHash`.

---

## 8. Tareas de implementación (orden)

1. **Deps**: `@nestjs/jwt`, `bcryptjs`, `@types/bcryptjs`, `@nestjs/throttler`.
2. **Prisma**: agregar `User` + `UserRole` + relación en `Tenant`; migración; regenerar cliente.
3. **`users`**: `UsersService` (findByEmail, create — con hashing en auth/signup).
4. **`auth`**: `AuthModule` con `JwtModule`, `AuthService`, `AuthController`
   (`/auth/login`, `/auth/me`), `JwtAuthGuard` global + `@Public()`.
5. **`signup`**: `SignupModule` con la transacción y el seeding de ALS (§4).
6. **Middleware**: reescribir `TenantContextMiddleware` para leer `req.user`.
   AppModule: registrar guard global + `ThrottlerModule` (login/signup).
7. **Env**: `JWT_SECRET`, `JWT_EXPIRES_IN` (default `1h`), `ALLOW_TENANT_HEADER` (dev).
   `.env` + `.env.example`.
8. **Tests**: unit + e2e del §7; actualizar los e2e de aislamiento existentes
   (signup+login en vez de header) y `test/utils.ts` (helper `signupAndAuth`).
9. **Docs**: README (setup, endpoints, auth) + cerrar UC-01 §11 (decisiones resueltas).

---

## 9. Criterios de aceptación

- Todos los tests del §7 en verde (`npm test` + `npm run test:e2e`), build y lint limpios.
- Signup sin intervención humana crea tenant usable de punta a punta (signup → login → tickets).
- Sin JWT no se accede a ningún recurso de tenant.
- Aislamiento A/B sigue probado, ahora con tokens.
- `x-tenant-id` ya no es fuente de confianza en prod.

---

## 10. Fuera de alcance

- Refresh tokens, logout server-side, MFA.
- Invites/multi-usuario (`MEMBER`) y roles avanzados.
- Billing/planes pagos (`PRO`/`ENTERPRISE`), verificación de email, recovery.
- OAuth/SSO, API keys de servicio.
- `/assist` del agente (bloque siguiente, depende de §11 de UC-01: modo de interacción).
