# Wizard de Signup Multi-Step — Instrucciones para el Frontend

> **Para quién:** equipo frontend.
> **Motivo:** mejorar el UX/UI del signup y recopilar contexto de la compañía
> (necesario para que el backend genere un system prompt por tenant).
>
> **Regla de oro:** el wizard es **solo UX**. Por detrás siempre se hace **UNA
> sola llamada** `POST /signup` con toda la info recopilada en un **JSON validado**.
> El backend no cambia su contrato de API (un solo endpoint, un solo body).

---

## 1. Idea central

El signup actual es un formulario plano. Queremos:

1. Un **wizard multi-step** (estilo ClickUp / onboarding): pasos con barra de progreso y navegación next/back.
2. Recopilar **datos de la compañía** en pasos dedicados (industria, descripción, contactos, tono de voz, idioma).
3. **Animación descendente** (slide hacia abajo + fade) entre pasos para una transición fluida.
4. Al final, **una sola petición** `POST /signup` con el payload completo y validado.

> El FE **acumula** todo en estado local (una sola fuente de verdad) y lo envía **una vez** en el último paso (review/submit). No hay llamadas parciales ni drafts al backend.

---

## 2. Flujo de pasos

```
   PASO 1           PASO 2            PASO 3            PASO 4            PASO 5
+--------------+  +--------------+  +--------------+  +----------------+  +----------------+
| Cuenta admin |→ | Compañía     |→ | Contexto del |→ | Tono & idioma |→ | Revisión &     |
| (tú)         |  | (nombre/slug)|  | negocio      |  |               |  | crear cuenta   |
+--------------+  +--------------+  +--------------+  +----------------+  +----------------+
   email           companyName        industry          brandVoice          review final
   password        workspaceName      companyDescription defaultLanguage    submit → POST /signup
```

| Paso | Campo(s) | Obligatorio | Validación FE |
|---|---|---|---|
| 1 — Cuenta | `adminEmail` | ✅ | formato email; password ≥ 8 |
| 1 — Cuenta | `adminPassword` | ✅ | ≥ 8 chars; confirmar (match) |
| 2 — Compañía | `companyName` | ✅ | no vacío, ≤ 120 |
| 2 — Compañía | `workspaceName` | ✅ | slug `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$` (preview del slug en vivo) |
| 3 — Negocio | `industry` | opcional | select con opciones (SaaS, Fintech, E-commerce, Software, Agencia, Otro) |
| 3 — Negocio | `companyDescription` | opcional | ≤ 500; 1–2 frases (placeholder guía) |
| 3 — Negocio | `supportEmail` | opcional | formato email |
| 3 — Negocio | `supportPhone` | opcional | `^\+?[0-9\s\-()]{7,20}$` |
| 4 — Tono/idioma | `brandVoice` | opcional | select: `professional` \| `friendly` \| `technical` \| `casual` |
| 4 — Tono/idioma | `defaultLanguage` | opcional | select: `es` \| `en` (default `es`) |
| 5 — Revisión | — | ✅ | resumen + checkbox términos + submit |

> **Importante para UX:** todos los campos de contexto (pasos 3 y 4) son **opcionales** en backend. El FE puede ofrecer defaults sugeridos para que el paso sea rápido de completar y nunca bloquee al usuario. Marca visualmente qué es opcional (`Opcional`) para no generar fricción.

---

## 3. Payload único enviado a `POST /signup`

```jsonc
{
  "companyName": "Acme",
  "workspaceName": "acme",
  "adminEmail": "admin@acme.dev",
  "adminPassword": "S3gura!2026",
  "plan": "FREE",                      // opcional; backend MVP solo acepta FREE

  // ★ Contexto de la compañía (nuevo) — para el system prompt por tenant
  "industry": "SaaS",
  "companyDescription": "Plataforma de gestión de tickets para equipos pequeños.",
  "supportEmail": "soporte@acme.dev",
  "supportPhone": "+34 600 123 456",
  "brandVoice": "friendly",
  "defaultLanguage": "es"
}
```

### Contrato de la respuesta

| HTTP | Caso | Notas FE |
|---|---|---|
| `201` | Éxito | Devuelve `{ tenantId, adminUserId, plan }` (NO token). Redirige a login. |
| `409` | Email o slug duplicado | Muestra error claro; sugiere volver al paso 2 para cambiar el slug. |
| `400` | Payload inválido | `message` puede ser **array** de errores por campo → mapea a cada campo del paso correspondiente. |

> **Campos desconocidos = 400**: el backend usa `forbidNonWhitelisted`. Solo envía los campos de esta especificación.

---

## 4. Comportamiento del wizard (UX/UI) ⭐

### 4.1 Barra de progreso (estilo ClickUp)

- Pasos numerados horizontalmente arriba (`1 2 3 4 5`) con **etiqueta** y separador.
- Estado por paso: `completado` (check verde + clickable para volver), `activo` (resaltado), `pendiente` (atenuado).
- El usuario puede **hacer click en un paso completado** para volver a él (los datos persisten).

### 4.2 Navegación

- Botones `Atrás` y `Continuar/Continuar →`.
- Al dar `Continuar` en un paso: **valida ese paso**; si hay errores, los muestra inline y NO avanza.
- `Continuar` en el paso final se convierte en `Crear cuenta` y dispara el `POST`.
- Guarda el estado en memoria/contexto (aunque uses estado local, no pierdas datos al navegar pasos).

### 4.3 Animación descendente entre pasos ⭐

- Transición **`slide-down + fade`** al **entrar** a un paso: el contenido nuevo desciende y se atenúa (opacidad 0→1) en ~250–350 ms con `ease-out`.
- Al **salir** de un paso: `slide-up + fade` en ~200 ms.
- Respeta `prefers-reduced-motion`: si el usuario pide reducir movimiento, **elimina el deslizamiento** y usa solo fade (o sin transición).
- Solo el **contenido del paso** se anima; la barra de progreso y los headers permanecen estáticos.

```css
/* ejemplo orientativo */
.step-enter { animation: slideDown 0.3s ease-out; }
@keyframes slideDown {
  from { transform: translateY(-16px); opacity: 0; }
  to   { transform: translateY(0);    opacity: 1; }
}
```

### 4.4 Estados de envío

| Estado | UX |
|---|---|
| Enviando | Botón `Crear cuenta` → spinner + texto "Creando tu cuenta…" y deshabilitado (evita doble submit). |
| Éxito (`201`) | Pantalla/panel de éxito con check animado; botón "Ir a iniciar sesión" (login). |
| Error de validación (`400`) | Banner de error + foco al primer campo erróneo; mapear errores por campo. |
| Duplicado (`409`) | Banner claro "Ese correo o nombre de workspace ya existe" + link "Cambiar workspace" (vuelve al paso 2). |
| Otro (`5xx`/red) | Mensaje genérico + botón "Reintentar"; no perder los datos ya llenados. |

### 4.5 Accesibilidad (obligatorio)

- **Foco**: al cambiar de paso, mover el foco al `h2`/contenedor del paso con `tabindex="-1"` + `focus()` (lectores de pantalla anuncian el nuevo paso).
- **ARIA**: `aria-live="polite"` en los mensajes de error/éxito; el stepper usa `aria-current="step"` en el paso activo.
- **Errores inline**: asociados al campo con `aria-describedby`; anunciados por el lector.
- **Formulario en un solo `<form>`**: un único form que envuelve todos los pasos y valida en submit final (mejor para autocompletado y a11y).
- **Keyboard**: Enter hace submit del paso actual (o navega), no rompe tabbing.
- **Contraste/tamaño**: el color del paso activo cumple WCAG AA.

### 4.6 Validación y defensa en profundidad

- El FE valida por paso (feedback inmediato) **y** revalida todo en el submit.
- El backend **revalida igualmente** (class-validator). Los mensajes del backend son la fuente final de verdad — mapea `message[]` a los campos.

---

## 5. Checklist de implementación FE

- [ ] Crear componente `<SignupWizard>` con stepper de 5 pasos.
- [ ] Formulario **único `<form>`** con estado compartido (una fuente de verdad).
- [ ] Validación por paso + revalidación en submit.
- [ ] Barra de progreso estilo ClickUp (completado/activo/pendiente, clickable).
- [ ] `Atrás` / `Continuar` / `Crear cuenta` con onChange del label correcto.
- [ ] **Animación descendente** (slide-down+fade) al entrar, slide-up+fade al salir; respeta `prefers-reduced-motion`.
- [ ] Estados de envío: spinner, éxito, `400`, `409`, `5xx` con reintento.
- [ ] A11y: foco por paso, `aria-current`, `aria-live`, `aria-describedby`, keyboard.
- [ ] Enviar **un solo** `POST /signup` con el payload JSON validado.
- [ ] Manejar respuesta `201` → redirigir a login; `409` → volver a paso 2 con mensaje.
- [ ] Probar manualmente: navegar todos los pasos, volver a pasos previos sin perder datos, validación por paso, doble submit bloqueado, reduced-motion.

---

## 6. Notas

- El backend acepta **campos opcionales** de contexto: si el usuario salta pasos 3/4, el signup igual funciona y el system prompt del tenant usa defaults.
- El `workspaceName` es el **slug**: muestra un preview en vivo (`acme` → `acme.agentdesk.app` o similar) y valida el regex en el paso 2.
- El contrato del formulario actual (`companyName`, `workspaceName`, `adminEmail`, `adminPassword`) **no cambia**; solo se **añaden** campos de contexto.
- CORS y auth: el signup es **público** (sin token). Envía `Content-Type: application/json` y `credentials: 'include'` por consistencia con el resto.

---

*Última actualización: 2026-09-02 · Backend: NestJS 11 · Un solo `POST /signup` con payload enriquecido.*
