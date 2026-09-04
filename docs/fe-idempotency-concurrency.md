# Idempotencia y concurrencia — Instrucciones para el Frontend

> **Para quién:** equipo frontend.
> **Motivo:** el backend ahora protege los flujos de conversación y tickets contra
> reintentos (retries por timeout/red/doble click) y carreras (dos requests a la
> vez sobre la misma conversación o ticket).
> **Solución aplicada en backend:** `idempotencyKey` en `POST /chat`, `version`
> (optimistic locking) en `PATCH /tickets/:id`, mutex por conversación y dedup de
> tools. Todo esto es **robustez del servidor**; aquí solo describimos **lo que el
> FE debe hacer (o dejar de hacer)** para no romper el contrato.
>
> Backend ya implementado y probado (115 unit + 45 e2e verdes) y desplegado en el
> contenedor de la API.

---

## 0. Resumen ejecutivo

| Mejora backend | ¿Afecta al FE? | Qué debe hacer el FE |
|---|---|---|
| `POST /chat` acepta `idempotencyKey` opcional | ✅ Sí (voluntario) | Generar una key por "intento" y reenviarla en reintentos |
| `PATCH /tickets/:id` acepta `version` + devuelve `409` | ✅ Sí (recomendado) | Enviar la `version` actual y manejar `409` |
| Mutex por conversación (serializa turnos) | ✅ Sí (solo lectura/UX) | No enviar 2 requests simultáneos sobre la misma conversación |
| `create_ticket` idempotente en DB | ⚪ No directo | Nada (efecto: reintentos ya no duplican tickets) |
| Tracing Langfuse / dedup interno / CAS interno | ⚪ No | Nada — es del servidor |

Los tres primeros son trabajo real del FE; el resto es contexto.

---

## 1. `POST /chat` — `idempotencyKey` (para retries seguros)

### Qué cambió
`POST /chat` ahora acepta un campo opcional:

```jsonc
{
  "message": "crea un ticket de facturación",
  "idempotencyKey": "abc-123"        // opcional, string ≤ 128 chars
}
```

**Para qué sirve:** si un request se cae (timeout, red, el usuario toca "enviar" dos
veces) y el cliente lo reintenta, el backend reutiliza la **misma conversación**
en vez de crear una duplicada — y no repite los efectos secundarios (p.ej. no crea
el ticket dos veces).

### Qué debe hacer el FE (recomendado)

**Genera una key única por cada "acción de usuario"** y reenvíala en cada reintento
de ese mismo mensaje. La key va asociada al **primer mensaje de una conversación
nueva** (cuando no envías `conversationId`):

```ts
// 1. Al crear NUEVA conversación (sin conversationId), genera una key por envío.
let key = crypto.randomUUID();

async function sendMessage(message: string) {
  const res = await fetch('/chat', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, idempotencyKey: key }),
  });
  if (!res.ok) {
    // ¿timeout/red? reintenta con la MISMA key para no duplicar.
    return sendMessage(message);
  }
  key = crypto.randomUUID();  // la conversación ya se creó → nueva key pa' futuros envíos
  return res.json();
}
```

Reglas:
- **Reintenta con la misma key** la acción que falló. Cambiar la key = tratarla como una acción nueva (podría duplicar).
- Cada **conversación distinta** (o mensaje de arranque distinto) usa una key distinta. No reutilices la misma key para varios chats.
- Si ya tienes `conversationId` (conversación en curso), **no hace falta** la key: el id del hilo ya identifica la conversación.
- La key no se expone al usuario; es un detalle de transporte.

### Código de Tool (`POST /chat`) — contexto
Aunque no lo llames desde el FE, `create_ticket` ahora es idempotente **en DB** (estampa cada ticket con su toolCallId). Eso significa que un **reintento** del `POST /chat` no duplica tickets, **incluso si el proceso del servidor se reinició** entre medio (antes solo había dedup en memoria). Es beneficio automático: solo tu parte (§1 la key) es necesaria.

---

## 2. `PATCH /tickets/:id` — `version` (optimistic locking)

### Qué cambió
`PATCH /tickets/:id` acepta ahora `version` opcional. Cada ticket trae un contador
`version` (empieza en `0`, se incrementa con cada update).

```jsonc
// GET /tickets → cada ticket tiene version
{ "id": "550e8400-...", "title": "Ayuda", "status": "OPEN", "version": 0 }

// PATCH /tickets/:id  → envía la version que TÚ leíste
{ "title": "Ayuda urgente", "version": 0 }
```

### Qué hace el backend
Si envías `version`, el update es **compare-and-swap**:
- Si la fila sigue en esa `version` → aplica y devuelve la nueva fila (con `version` incrementada).
- Si **otra request ya la cambió** (otra tab, otro usuario) → responde **`409 Conflict`** con body Nest: `{ "statusCode": 409, "message": "...", "error": "Conflict" }`.
- Si **no** envías `version` → update sin control de concurrencia (comportamiento previo, "el último gana").

### Qué debe hacer el FE (recomendado)
1. **Lee y guarda `version`** junto al ticket (del `GET` o del `CREATE`).
2. **Envíala al actualizar** para no pisar cambios de otro usuario.
3. **Maneja el `409`**: refresca el ticket y deja que el usuario decida (reintentar, fusionar, sobreescribir).

```ts
async function updateTicket(id: string, patch: object, version: number) {
  const res = await fetch(`/tickets/${id}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...patch, version }),
  });

  if (res.status === 409) {
    // Otra persona lo editó. Refresca y pregunta al usuario.
    const fresh = await fetch(`/tickets/${id}`, { credentials: 'include' });
    showConflictDialog(await fresh.json());
    return null;
  }
  return res.json(); // ticket actualizado (con version nueva)
}
```

> **Nota sobre el agente:** cuando el agente (`POST /chat`) usa `update_ticket`, la
> herramienta **pasa la `version` por sí sola** y devuelve el error como
> `toolResults[].result.code === 'CONFLICT'` si hubo lost-update — el modelo relee y
> reintenta. **El FE no tiene que gestionar esto** en el flujo de chat; solo es
> relevante si tu UI edita tickets directamente vía REST.

---

## 3. Concurrencia de conversación — comportamiento del servidor

### Qué cambió
El backend **serializa los turnos de una misma conversación** con un mutex por
conversación. Si lanzas dos requests sobre la **misma** `conversationId` a la vez
(por ejemplo `POST /chat` y `POST /chat/approve` casi simultáneos, o dos `POST
/chat`):

- El segundo **espera** a que el primero termine, y luego ejecuta.

### Qué debe hacer el FE
Es **solo una recomendación de UX/arquitectura**: no lances requests paralelos
sobre la misma conversación; encolálos en el cliente (o deshabilita el botón de
enviar mientras un turno está en curso). El backend no rompe nada si lo haces, pero
evitarás esperas inesperadas y estados confusos.

```ts
let turnInFlight = false;

async function send(message: string) {
  if (turnInFlight) return;          // ya hay un turno corriendo
  turnInFlight = true;
  try {
    await fetch('/chat', { /* ... */ });
  } finally {
    turnInFlight = false;
  }
}
```

> La pausa de aprobación (flujo existente `awaitingApproval` + `POST /chat/approve`)
> sigue igual. Lo único nuevo es que, si el FE dispara `chat` y `approve` a la vez,
> el servidor los ordena; lo correcto en el FE es esperar el detalle de la pausa
> antes de enviar la decisión.

---

## 4. Checklist de implementación FE

- [ ] (`POST /chat`) Generar `idempotencyKey` por cada arranque de conversación nueva (ideal: `crypto.randomUUID()`).
- [ ] Reintentar una acción fallida con la **misma key** (no una nueva).
- [ ] No usar `idempotencyKey` al continuar una conversación que ya tiene `conversationId`.
- [ ] (`PATCH /tickets/:id`) Leer y guardar `version` con cada ticket.
- [ ] Enviar `version` al actualizar un ticket.
- [ ] Manejar `409 Conflict` en `PATCH /tickets/:id`: refrescar el ticket y ofrecer al usuario resolver el conflicto.
- [ ] Evitar requests paralelos sobre la misma `conversationId` (bloquear el envío mientras hay un turno en curso).
- [ ] Regresión: crear ticket por chat + reintento con misma key no duplica; editar ticket en dos pestañas → 2ª edición sin pisar.

---

## 5. Notas y aclaraciones

- **Los campos nuevos son opcionales y hacia atrás compatibles:** si el FE omite
  `idempotencyKey` y `version`, la API funciona como antes (sin dedup client-side y
  con update "el último gana"). Las mejoras solo se activan cuando se usan.
- **Los reintentos de `PATCH` también:** con `version` reutilizada, el segundo
  `PATCH` cable devuelve `409` (ya aplicado) — es la señal de "ya lo hiciste". Si tu
  patrón de reintento automático lo ve, trata el `409` de un retry como éxito si el
  contenido ya refleja tu cambio, o relee.
- **Nada de esto cambia el transporte de sesión** (cookies HttpOnly de la guía de
  sesión) ni el formato de respuesta `ChatResponse`.
- **Errores de tool vs errores HTTP:** los fallos de herramientas del agente llegan
  dentro de `toolResults[].result` (con `success:false` y `code`), **no** como
  error HTTP. Eso ya estaba documentado; solo se añadió el code `CONFLICT` para
  lost-updates vía agente (no requiere acción del FE).

---

*Última actualización: 2026-09-03 · Backend: NestJS 11 · Endpoints tocados: `POST /chat`, `PATCH /tickets/:id`*
