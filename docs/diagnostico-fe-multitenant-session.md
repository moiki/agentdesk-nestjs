# Diagnóstico del error: datos de una sesión visibles en otra cuenta (multi-tenant)

> **Síntoma reportado:** al iniciar sesión en una cuenta (tenant A), crear tickets o
> conversar con la IA, luego cerrar sesión y entrar con otra cuenta (tenant B),
> **se ve todo lo que se hizo en la sesión anterior**.
>
> **Regla esperada en multi-tenant:** la única identidad de tenant es el **JWT**.
> El backend NO usa header `x-tenant-id` (salvo env de dev) y aplica aislamiento
> estructural en el servidor (AsyncLocalStorage + Prisma scoping). Si los datos del
> tenant A aparecen cuando estás logueado como tenant B, el 99% del problema está
> **en el frontend** guardando/cacheando estado que no limpia al cambiar de cuenta.

---

## 0. Confirmación rápida: ¿es el backend o el FE?

Antes de tocar nada, haz una prueba directa contra la API (sin FE) para descartar
el servidor:

```bash
API=http://localhost:3000

# Login tenant A
TOKEN_A=$(curl -sX POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin-a@x.dev","password":"..."}' | jq -r .accessToken)

# Login tenant B
TOKEN_B=$(curl -sX POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin-b@x.dev","password":"..."}' | jq -r .accessToken)

# Tickets de A con token A
echo "Tickets de A con token A:"
curl -s $API/tickets -H "Authorization: Bearer $TOKEN_A" | jq .

echo "Tickets de B con token B (NO debe incluir los de A):"
curl -s $API/tickets -H "Authorization: Bearer $TOKEN_B" | jq .
```

**Si** con `Token B` la lista incluye tickets de A → el problema es del **backend**
(regrésalo: es algo grave). **Si** con `Token B` la lista viene vacía → el backend
está sano y el cauce de datos sucio está en el **FE** (state/caché que no se limpia).

---

## 1. Las 4 causas raíz típicas en el frontend (revisa en orden)

El backend entrega los datos correctos por tenant. La fuga visual casi siempre viene
de que el FE **no limpia estado entre sesiones**. Causas en orden de probabilidad:

### 1.1 🔴 State global (Redux / Zustand / Context) que persiste tras logout
El state de tickets, conversaciones, etc. queda en memoria del store y **no se
resetea** en el logout.

- **Síntoma:** al entrar con tenant B, los tickets/conversaciones de A siguen
  pintados en pantalla **sin** que el FE vuelva a llamar a `/tickets`.
- **Fix:** en el `logout()` (y al recibir 401→login) haz `store.reset()` /
  `dispatch({ type: 'RESET_ALL' })` / `clear()` de **todos** los slices, no solo
  el de auth.

### 1.2 🟠 Caché duplicada del query (React Query / SWR / Apollo)
Los datos quedan cacheados por una key que **no incluye el tenant/user**, o el
logout no invalida la caché.

- **Fix:**
  - Incluye `tenantId`/`userId` en la query key: `['tickets', user.tenantId]`.
  - En logout: `queryClient.clear()` (React Query) / `cache.evict()` (Apollo) /
    `cache.invalidateEverything()` (TanStack).
  - Si usas SWR con keys globales, asegúrate de limpiar el cache on logout.

### 1.3 🟠 Acceso residual a datos por el id de la conversación/ticket guardado globalmente
El FE guarda el último `conversationId`/ticket seleccionado en un store global o
`localStorage` y al cambiar de cuenta lo sigue usando. El backend devolverá 404/400
para datos de otro tenant, pero la UI puede mostrar "dato fantasma" o el id viejo.

- **Fix:** nunca persistas ids de dominio en `localStorage/sessionStorage`.
  Al hacer login nuevo, borra cualquier estado "última conversación / selección".

### 1.4 🟠 Caché de navegación / memoria del router
Al cerrar sesión la app "vuelve" a la vista anterior (ej. dashboard con la lista ya
pintada) y React la re-usa vía caché de montaje/estado anterior del componente.

- **Fix:** al desloguear, forzar la navegación a `/login` y **desmontar** los
  componentes de datos (key del árbol de rutas), no solo ocultarlos.

---

## 2. Checklist de revisión del código FE

Revisa en el código de tu FE (`localhost:5173`):

- [ ] **Store de estado** (Redux/Zustand/Context): ¿hay un action `reset` completo?
  ¿El logout lo llama? ¿Quedan slices de tickets/conversaciones sin limpiar?
- [ ] **Query cache** (React Query / SWR / Apollo): ¿logout invalida/limpia toda la
      caché? ¿Las keys incluyen el tenant?
- [ ] **`localStorage` / `sessionStorage` / `document.cookie`**: busca cualquier
      lectura de tokens o datos de dominio. Los tokens deben ser HttpOnly (no
      accesibles desde JS) y **no** deben estar en `localStorage`. Borra cualquier
      caché manual que guarde tickets/conversaciones/tenantId.
- [ ] **Al hacer login nuevo**, ¿se monta una vista limpia o se re-usa el estado
      anterior del componente?
- [ ] **`credentials: 'include'` / `withCredentials: true`** en TODAS las llamadas
      a la API, para que la cookie `access_token`/`refresh_token` viaje. Sin esto
      no hay sesión persistente correcta ([fe-session-persistence.md](./fe-session-persistence.md)).
- [ ] **Bootstrap** llama a `POST /auth/refresh` al arrancar; si responde 200 con
      el usuario correcto → no mostrar login; si 401 → datos de la sesión previa
      deben borrarse ANTES de mostrar login.
- [ ] **Interceptor de 401**: al refrescar, ¿reescribe el usuario/tenant en el
      store, o conserva el state del usuario anterior?

---

## 3. Reproducción manual (guía paso a paso)

1. Con tenant A: loguea, crea 2-3 tickets y haz una conversación en el chat.
2. Cierra sesión (usa el botón del FE, que llama a `POST /auth/logout`).
3. En DevTools → Application → Cookies: verifica que `access_token` y
   `refresh_token` **desaparecieron** tras el logout.
4. Entra con tenant B y observa la **red** (pestaña Network):
   - ¿El FE hace llamada a `GET /tickets` al montar? ¿Con qué token/cookie?
   - ¿La respuesta es la correcta (vacía para B) o el FE **no** llamó y está
     mostrando datos cacheados de A?
5. Si el FE **no hace la petición** pero muestra tickets → es **cache/state** (1.1/1.2).
6. Si el FE **sí hace la petición** pero la respuesta trae datos de A → es backend
   (vuelve a §0).

> 💡 Clave de diagnóstico: **¿la fuga aparece sin pedir datos al servidor?**
> Si sí → bug FE (estado/caché). Si la fuga viene "del servidor" → reproduce con
> curl (§0) para confirmarlo.

---

## 4. Fixes recomendados (resumen)

| Causa | Fix concreto |
|---|---|
| State global no reseteado | `logout()` → reset de TODOS los slices del store |
| Query cache no invalidado | `queryClient.clear()` / `cache.invalidateEverything()` on logout |
| Keys sin tenant | Incluir `tenantId` en las query keys |
| Ids de dominio en storage | No usar `localStorage` para conversations/tickets; borrar on login |
| Router/caché de vista | Desmontar el árbol de datos al ir a `/login`, no solo ocultarlo |

---

## 5. Referencia del contrato backend (para confirmar comportamiento correcto)

- **Identidad de tenant = JWT únicamente.** No hay `x-tenant-id` (excepto env de dev `ALLOW_TENANT_HEADER`).
- **Login** → `POST /auth/login` → `{ accessToken }` + cookies HttpOnly (`access_token`, `refresh_token`).
- **Logout** → `POST /auth/logout` → invalida refresh token y borra cookies.
- **Bootstrap** → `POST /auth/refresh` → si 200, renovado; si 401, sin sesión.
- **Tickets de otro tenant → `404`** (no revela existencia). **Chat de otro tenant → `400`**.
- Docs FE del repo: `docs/fe-session-persistence.md`, `docs/integration-guide.md`.

---

*Generado para diagnóstico del bug multi-tenant · Backend: NestJS 11 + Prisma 7 + Postgres*
