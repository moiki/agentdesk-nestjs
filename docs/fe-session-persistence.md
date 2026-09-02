# Sesión persistente entre tabs — Instrucciones para el Frontend

> **Para quién:** equipo frontend.
> **Motivo:** al abrir una nueva tab o recargar la página, el FE pedía login otra vez.
> **Solución aplicada en backend:** sesión basada en **cookies HttpOnly** con
> `access_token` (corto plazo) + `refresh_token` (largo plazo, rotativo), más el
> endpoint `POST /auth/refresh`.
>
> Este documento describe **solo lo que el FE tiene que cambiar**. Backend ya está
> implementado y probado (92 unit + 45 e2e verdes).

---

## 1. Qué cambió en la API

| Endpoint | Auth | Cambio |
|---|---|---|
| `POST /auth/login` | pública | Ahora además del body `{ accessToken }`, **setea dos cookies HttpOnly** (`access_token`, `refresh_token`) |
| `POST /auth/refresh` | pública (usa cookie) | **Nuevo.** Rota el `refresh_token` y devuelve `{ accessToken }` fresco + refresca las cookies |
| `POST /auth/logout` | pública (usa cookie) | **Nuevo.** Invalida el refresh token y limpia las cookies |
| `GET /auth/me` (y todos los autenticados) | Bearer **o cookie** | El backend acepta ahora el token desde la cookie `access_token` si no viaja el header `Authorization` |

**Idea central:** las cookies HttpOnly son **compartidas entre todas las tabs del
mismo navegador** y sobreviven a recargas. Por eso la sesión deja de perderse al
cambiar de tab o refrescar. El frontend ya **no tiene que guardar el token en
memoria/sessionStorage ni re-loginear**.

---

## 2. Configuración necesaria (crítica)

Para que las cookies viajen entre tu FE (`http://localhost:5173`) y la API
(`http://localhost:3000`) **tienes que habilitar credenciales en las peticiones**,
o el navegador no las enviará ni las guardará:

```ts
// fetch nativo
fetch('http://localhost:3000/auth/login', {
  method: 'POST',
  credentials: 'include',          // ← REQUERIDO
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});

// axios
axios.post('/auth/login', { email, password }, { withCredentials: true });
```

> Sin `credentials: 'include'` (fetch) / `withCredentials: true` (axios), el login
> funcionará pero las cookies **no se guardarán**, y por tanto **no habrá sesión**
> persistente — mismo síntoma actual. Este es el punto que más probablemente está
> causando el problema si ya intentaste cookies antes.

---

## 3. Bootstrap de la app (recarga / apertura nueva tab)

En el **arranque** de tu SPA (antes de montar la UI o en paralelo), intenta renovar
la sesión si existe una cookie refresh guardada:

```ts
async function bootstrapSession() {
  try {
    const res = await fetch('/auth/refresh', { method: 'POST', credentials: 'include' });
    if (res.ok) {
      const { accessToken } = await res.json();
      // guarda accessToken en memoria (Redux/Context) para los requests del turno
      return accessToken;
    }
    return null;              // sin sesión → mostrar login
  } catch {
    return null;              // red caída o 401 → mostrar login
  }
}
```

Si responde `200`: el usuario sigue logueado → **no muestres el login**.
Si responde `401`: no hay sesión válida → muestra el login normalmente.

### Qué hace cada cookie (no las toques desde JS)

| Cookie | Vida | Rol en el FE |
|---|---|---|
| `access_token` | ~1h | La lee el backend para autorizar requests si no mandas header. **HttpOnly: tu JS no puede (ni debe) leerla.** |
| `refresh_token` | ~30d | La usa `POST /auth/refresh`. **HttpOnly.** |

> Al ser `HttpOnly`, **Java­Script no puede leer los tokens**. Tu cliente nunca debe
> intentar `document.cookie` ni guardar tokens en localStorage. Usa la respuesta
> `{ accessToken }` de `/auth/login` y `/auth/refresh` para los headers de ese turno.

---

## 4. Flujo de requests autenticados

Dos opciones (elige una y sé consistente):

### Opción A — Solo cookies (recomendada, más simple)
Confía en la cookie `access_token` que el backend lee automáticamente. No mandes
`Authorization` manualmente. Solo asegura `credentials: 'include'` en **todas** las
llamadas a la API.

- Pro: cero gestión de tokens en el cliente.
- Contra: cuando el `access_token` expira (~1h) la request devuelve `401`. Por eso
  necesitas el renova-automático del §5.

### Opción B — Cookie + header (híbrida)
Sigue mandando `Authorization: Bearer <accessToken>` con el token que guardaste en
memoria (del login o del refresh). El header tiene prioridad sobre la cookie.

- Pro: el backend no depende de que la cookie llegue para cada request.
- Contra: debes manejar el vencimiento igual (ver §5).

---

## 5. Manejo del vencimiento (refresh automático) ⭐

El `access_token` dura ~1h. Para que el usuario **nunca** vea un login por
vencimiento, intercepta los `401` y renueva con `POST /auth/refresh`:

```ts
// Interceptor de 401 con reintento
let refreshing = null;

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, credentials: 'include' });

  if (res.status === 401 && !options._retried) {
    if (!refreshing) {
      refreshing = fetch('/auth/refresh', { method: 'POST', credentials: 'include' })
        .then((r) => r.json())
        .finally(() => (refreshing = null));
    }

    const { accessToken } = await refreshing;
    if (accessToken) {
      return api(path, { ...options, _retried: true });   // reintenta el request
    }
    redirectToLogin();
  }
  return res;
}
```

> Solo reintenta **una vez** (flag `_retried`) para no entrar en bucle. Si el refresh
> falla, la sesión terminó → redirige a login. Un solo renovador compartido
> (`refreshing`) evita que N requests expirados disparen N refreshes en paralelo.

---

## 6. Logout

```ts
await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
// limpia estado de sesión en memoria y redirige a login
```

El backend invalida el refresh token (y borra las cookies). Después, limpia
cualquier token/estado en memoria del cliente.

---

## 7. Checklist de implementación FE

- [ ] **`credentials: 'include'` / `withCredentials: true`** en TODAS las llamadas a la API (fetch o axios).
- [ ] **Bootstrap** llama a `POST /auth/refresh` al arrancar; si `200` → no mostrar login.
- [ ] **Interceptor de 401** que hace refresh una vez y reintenta el request.
- [ ] Guardar `accessToken` (respuesta de login/refresh) en memoria — **no** en localStorage ni `document.cookie` (HttpOnly).
- [ ] **Logout** llama a `POST /auth/logout` y limpia el estado en memoria.
- [ ] Verificar en DevTools (pestaña Application → Cookies) que `access_token` y `refresh_token` existen tras login y que **no** son accesibles desde la consola (HttpOnly).
- [ ] Probar manualmente: login → abrir nueva tab → seguir logueado; recargar pestaña → seguir logueado; esperar >1h o rotar token → no pedir login.

---

## 8. Notas / limitaciones

- **`SameSite=Lax`** por defecto: las cookies se envían en navegaciones cross-site normales. Si FE y API comparten hostname en producción, sin problema. Para dev localhost→localhost también.
- **`Secure`** está en `false` por defecto (dev sobre HTTP). En **producción (HTTPS)** el backend debe arrancar con `COOKIE_SECURE=true`.
- CORS ya tiene `credentials` habilitado en el backend; FE debe enviar `credentials` para completar el contrato.
- La cookie **refresh es rotativa**: cada `POST /auth/refresh` consume la anterior y entrega una nueva. No la reutilices manualmente.

---

*Última actualización: 2026-08-31 · Backend: NestJS 11 · Endpoints nuevos: `/auth/refresh`, `/auth/logout`*
