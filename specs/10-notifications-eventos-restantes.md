# SPEC 10 — Notifications: los seis eventos restantes (plantillas, puente, cambios de payload y avisos a varias tiendas)

> **Status:** Implementado (ver "Notas de implementación")
> **Depends on:** SPEC 03, SPEC 07, SPEC 08, SPEC 09
> **Date:** 2026-11-09
> **Objective:** Cablear de punta a punta (puente, RabbitMQ, plantilla y aviso guardado) `user.registered`, `provider.rejected`, `payment.approved`, `payment.declined`, `order.confirmed` y `order.cancelled`, sobre la infraestructura del SPEC 09, y añadir a `order` y `payments` los campos de payload que hacen falta para saber a quién avisar.

## Por qué existe este spec

El SPEC 09 dejó el transporte funcionando con un solo evento, `provider.approved`. `NOTIFIABLE_EVENTS` (`libs/common/src/messaging/topology.ts`), la lista blanca (`event-sanitizer.policy.ts`) y el registro de plantillas (`notification-templates.ts`) tienen una sola entrada. `docs/reglas-de-negocio.md` dice que `notification` consume siete eventos y que "avisa al productor y a cada tienda del resultado" del pedido.

Hoy dos payloads no alcanzan para eso:

- `payment.approved` y `payment.declined` llevan `orderId`, `paymentId` y `monto` o `motivo`, pero **no `buyerId`**: no se sabe a quién avisar.
- `order.confirmed` lleva `orderId`, `buyerId` y `total`, pero **no las tiendas** del pedido (están en `sub_orders`, que solo conoce `order`).

Decisiones no obvias que este spec cierra:

- **Los payloads se amplían en el origen, no en el puente.** El puente no puede consultar `order` ni `payments` (frontera de módulos y desacople). `order.confirmed` suma `storeIds` y `payment.*` suman `buyerId`. Son campos nuevos: ningún consumidor existente (`catalog`, `order`) los usa ni se rompe.
- **Una plantilla devuelve varios avisos.** `order.confirmed` produce un aviso `USER` para el productor y uno `STORE` por cada tienda. La idempotencia del SPEC 09 (índice único `eventId + destinatarioTipo + destinatarioId`) ya admite varios avisos por evento; solo cambia cómo `handle` trata el error 11000 (ver "Servicio").
- **`order.cancelled` avisa solo al productor.** Las tiendas nunca vieron el pedido como firme, así que no se les avisa de una cancelación (incluye `STOCK_REJECTED`, `EXPIRED`, `STOCK_TIMEOUT` y `LATE_RESERVATION`). Si más adelante se quiere, es otro cambio de payload.
- **El motivo técnico no sale al aviso.** `payment.declined` no reenvía `motivo` y `order.cancelled` lo usa solo para elegir el texto. El usuario no ve códigos internos.
- **`provider.rejected` sí reenvía `reason`.** Es texto escrito por el ADMIN para que el proveedor sepa por qué lo rechazaron; sin él el aviso no sirve. Es un campo libre: la plantilla lo recorta a 200 caracteres y no pasa por `email` ni documentos. Riesgo aceptado (ver Riesgos).
- **Los eventos de `order` y `payments` ya traen `eventId`** (sobre `DomainEvent`, `emitAsync`). El puente lo **reutiliza**; solo los de `auth` (sin sobre) reciben uno nuevo. Así un reenvío desde el outbox de `order` o desde la reemisión de `payments` es idempotente en `notification_outbox`.
- **`order.created` no es notificable.** No está entre los eventos de `notification` en las reglas y avisar de un pedido que aún puede fallar por stock sería ruido.

## Alcance

**Dentro:**

- **`order`:** `order.confirmed` incluye `storeIds` (las tiendas de los `sub_orders` del pedido), leídas dentro de la misma transacción que escribe el outbox.
- **`payments`:** `payment.approved` y `payment.declined` incluyen `buyerId` (ya está en el `Payment`), también en la reemisión.
- **`libs/common`:** `NOTIFIABLE_EVENTS` pasa a siete tipos.
- **`notification-bridge`:** listeners de los seis eventos, lista blanca de cada uno y reutilización del `eventId` cuando el evento ya trae sobre.
- **`notifications`:** seis plantillas nuevas, amplía `PLANTILLAS`, `handle` con varios avisos por evento, y utilidades de validación de payload compartidas.
- **Pruebas:** unitarias por pieza y e2e de los seis eventos, incluido el flujo completo checkout → pago → aviso al productor y a la tienda.
- **Documentación:** `docs/reglas-de-negocio.md` y `CLAUDE.md`.

**Fuera de alcance (para specs futuros):**

- Avisar a las tiendas de una cancelación y avisar al `ADMIN` (p. ej. de una solicitud de proveedor nueva).
- Email, SMS o push reales.
- Endpoints de lectura de avisos y `/internal/*` con token de servicio. El frontend sigue sin poder leer avisos.
- Preferencias de notificación por usuario, plantillas editables y localización.
- Reproceso manual de la DLQ y de eventos `FAILED` del puente.
- Limpieza (TTL) de `notification_outbox` y de `notifications`.
- Avisos de `order.created`, `stock.*` y `store.created`.
- `auth` pasa a `emitAsync` (sigue siendo riesgo aceptado del SPEC 09).

## Cambios de payload en los módulos de origen

### `order`: `order.confirmed` con `storeIds`

```ts
// modules/order/events/order.events.ts
type OrderConfirmedPayload = {
  orderId: string;
  buyerId: string;
  total: number;
  storeIds: string[]; // ObjectId hex; sin repetidos; al menos uno
};
```

En `OrderSagaService.handlePaymentApproved`, dentro del callback transaccional, se leen los `sub_orders` con `find({ orderId }, { storeId: 1 }, { session })` y se pasa `storeIds` a `OutboxService.add`. Un pedido sin `sub_orders` no debe existir; si pasa, la transacción falla (no se confirma un pedido sin tiendas) y se reintenta con el mismo `payment.approved`.

`catalog` consume `order.confirmed` con sus propios tipos y no valida estrictamente el payload: se verifica en el paso 1 que ignora el campo nuevo. Los specs y e2e de `order` que comparan el payload completo se actualizan.

### `payments`: `buyerId` en `payment.approved` y `payment.declined`

```ts
// los tipos viven en order/events (los reexporta payments)
type PaymentApprovedPayload = {
  orderId: string;
  paymentId: string;
  buyerId: string;   // nuevo
  monto: number;
};
type PaymentDeclinedPayload = {
  orderId: string;
  paymentId: string;
  buyerId: string;   // nuevo
  motivo: string;
};
```

`EmittablePayment` suma `buyerId` y `buildEnvelope` lo incluye. La consulta del job de reemisión debe traerlo (proyección o documento completo). El `Payment` ya guarda `buyerId` desde el SPEC 08, así que los pagos antiguos tampoco quedan sin él. `order` ignora el campo nuevo.

## Modelo de datos

### Lista blanca (`policies/event-sanitizer.policy.ts`)

Se añaden estas filas a la del SPEC 09:

| Tipo | Campos que salen | Se descartan |
| --- | --- | --- |
| `user.registered` | `userId`, `rol`, `status` | `email` |
| `provider.rejected` | `userId`, `reviewedBy`, `reason` | `email` |
| `payment.approved` | `orderId`, `paymentId`, `buyerId`, `monto` | cualquier otro |
| `payment.declined` | `orderId`, `paymentId`, `buyerId` | `motivo` y cualquier otro |
| `order.confirmed` | `orderId`, `buyerId`, `total`, `storeIds` | cualquier otro |
| `order.cancelled` | `orderId`, `buyerId`, `motivo` | cualquier otro |

### `NOTIFIABLE_EVENTS`

```ts
export const NOTIFIABLE_EVENTS: readonly string[] = [
  'user.registered',
  'provider.approved',
  'provider.rejected',
  'payment.approved',
  'payment.declined',
  'order.confirmed',
  'order.cancelled',
];
```

`declareTopology` ya añade un enlace por cada tipo y es idempotente: al arrancar con la lista nueva, la cola existente recibe los enlaces que faltan sin recrearse.

### `Notification.plantilla`

`PLANTILLAS` pasa a:

```ts
['USER_REGISTERED', 'PROVIDER_APPROVED', 'PROVIDER_REJECTED',
 'PAYMENT_APPROVED', 'PAYMENT_DECLINED',
 'ORDER_CONFIRMED_BUYER', 'ORDER_CONFIRMED_STORE', 'ORDER_CANCELLED']
```

No cambia ningún índice ni el resto del schema.

## Puente en el monolito

### Listeners

Se crean dos listeners según cómo llega el evento, porque `auth` emite sin sobre y `order` y `payments` emiten con el sobre `DomainEvent`:

- **Eventos de `auth`** (`user.registered`, `provider.rejected`, y el `provider.approved` que ya existe): sin `eventId`; el puente lo genera con uuid v4, `occurredAt` ahora y `correlationId = userId`. Mismo comportamiento y mismos riesgos que el SPEC 09.
- **Eventos con sobre** (`payment.approved`, `payment.declined`, `order.confirmed`, `order.cancelled`): se **reutiliza** `eventId`, `occurredAt` y `correlationId` del sobre recibido (el `orderId`). Se filtra el payload y se inserta en `notification_outbox`.

En ambos casos: un error 11000 sobre `eventId` se ignora; cualquier otro error se registra con `error` (sin payload) y **se relanza**. En los eventos con sobre, relanzar es lo que importa: se emiten con `emitAsync`, así que `order` (outbox) y `payments` (reemisión) reintentan solos.

`notification-bridge` importa de `order` y `payments` solo desde `modules/order/index.js` y `modules/payments/index.js`:

- `order/index.ts` ya exporta `OrderEvents`, `DomainEvent` y los tipos de payload; debe exportar `ConsumedEvents` si el puente lo necesita para `payment.*`. Se prefiere `PaymentEvents` desde `payments/index.js`.
- Ningún módulo importa archivos internos de `notification-bridge`.

> El payload de los eventos con sobre se valida contra la lista blanca, que es una función pura sobre `Record<string, unknown>`; no se duplican los tipos de `order` y `payments` en el puente.

## Consumidor y plantillas en `notifications`

### Servicio (`services/notifications.service.ts`)

`handle(event)` obtiene los borradores de la plantilla y los guarda con `insertMany` (`ordered: false`). Un error 11000 es "ya procesado" **por borrador**, no por evento: si un reintento ya había guardado algunos avisos, los que faltan se crean y los repetidos se ignoran. Cualquier otro error sigue siendo fallo de procesamiento (reintento y DLQ del SPEC 09). El log lista `plantilla`, `destinatarioTipo` y `destinatarioId` de cada aviso, nunca el mensaje.

El consumidor no cambia: ya hace `ack` si `handle` termina, `ack` con `warn` si el evento no tiene plantilla y `nack` según el número de entregas si lanza.

### Validación compartida (`templates/payload.ts`)

Se extraen de `provider-approved.template.ts`:

- `InvalidEventPayloadError`.
- `requireObjectId(event, campo)`: string de 24 hex o lanza.
- `requireObjectIdList(event, campo)`: arreglo no vacío de ObjectId válidos, sin repetidos; si no, lanza.
- `formatCop(monto)`: entero no negativo a texto `$1.250.000` (`es-CO`, sin decimales); si no es entero, lanza.

`provider-approved.template.ts` pasa a usarlos sin cambiar su resultado.

### Plantillas (funciones puras, sin email ni datos personales)

| Evento | Destinatario | `plantilla` | `titulo` | `mensaje` |
| --- | --- | --- | --- | --- |
| `user.registered` con `rol: PRODUCTOR` | `USER` / `userId` | `USER_REGISTERED` | `Bienvenido a Mini-Croper` | `Tu cuenta fue creada. Ya puedes explorar el catálogo y hacer pedidos.` |
| `user.registered` con `rol: PROVEEDOR` (`status: PENDING_APPROVAL`) | `USER` / `userId` | `USER_REGISTERED` | `Solicitud recibida` | `Recibimos tu solicitud como proveedor. Te avisaremos cuando un administrador la revise.` |
| `provider.rejected` | `USER` / `userId` | `PROVIDER_REJECTED` | `Solicitud rechazada` | Con `reason`: `Tu solicitud como proveedor fue rechazada. Motivo: <reason recortado a 200>.` Sin `reason`: `Tu solicitud como proveedor fue rechazada.` |
| `payment.approved` | `USER` / `buyerId` | `PAYMENT_APPROVED` | `Pago recibido` | `Recibimos tu pago de <formatCop(monto)> del pedido <orderId>.` |
| `payment.declined` | `USER` / `buyerId` | `PAYMENT_DECLINED` | `Pago rechazado` | `No pudimos procesar tu pago del pedido <orderId>. Puedes intentarlo de nuevo mientras el pedido siga vigente.` |
| `order.confirmed` | `USER` / `buyerId` | `ORDER_CONFIRMED_BUYER` | `Pedido confirmado` | `Tu pedido <orderId> por <formatCop(total)> quedó confirmado.` |
| `order.confirmed` | `STORE` / cada `storeIds[i]` | `ORDER_CONFIRMED_STORE` | `Nuevo pedido` | `Tu tienda tiene un pedido confirmado: <orderId>.` |
| `order.cancelled` | `USER` / `buyerId` | `ORDER_CANCELLED` | `Pedido cancelado` | Según `motivo`: ver abajo |

Textos de `order.cancelled` según `motivo`:

| `motivo` | `mensaje` |
| --- | --- |
| `STOCK_REJECTED` | `Tu pedido <orderId> se canceló porque algún producto ya no tiene existencias suficientes.` |
| `EXPIRED` | `Tu pedido <orderId> se canceló porque venció el plazo de pago.` |
| `STOCK_TIMEOUT` | `Tu pedido <orderId> se canceló porque no pudimos reservar las existencias a tiempo.` |
| `LATE_RESERVATION` | `Tu pedido <orderId> se canceló. Si hiciste algún pago, escríbenos para revisarlo.` |
| otro valor | lanza `InvalidEventPayloadError` (reintentar no lo arregla, pero el consumidor lo trata como fallo) |

Reglas comunes: un `userId`, `buyerId`, `orderId` o `storeId` que no sea ObjectId lanza `InvalidEventPayloadError`; `monto` y `total` deben ser enteros no negativos. `order.confirmed` produce **1 + N** borradores con un solo evento. Los mensajes llevan el `orderId` porque no hay endpoint de lectura que lo enlace; no llevan nombres, documentos ni correos.

## Estructura de archivos

```text
libs/common/src/messaging/topology.ts            # NOTIFIABLE_EVENTS con 7 tipos
apps/api/src/modules/order/
  events/order.events.ts                         # OrderConfirmedPayload con storeIds; PaymentApproved/DeclinedPayload con buyerId
  services/order-saga.service.ts                 # lee sub_orders en la transacción
apps/api/src/modules/payments/services/
  payment-events.service.ts                      # buyerId en el sobre y en la reemisión
apps/api/src/modules/notification-bridge/
  policies/event-sanitizer.policy.ts             # +6 filas
  services/
    bridge-listener.service.ts                   # eventos de auth (3 tipos)
    bridge-envelope-listener.service.ts          # eventos con sobre (4 tipos)
  tests/                                         # specs planos
apps/notifications/src/
  schemas/notification.schema.ts                 # PLANTILLAS ampliado
  services/notifications.service.ts              # varios avisos por evento
  templates/
    payload.ts                                   # validación compartida y formatCop
    user-registered.template.ts
    provider-rejected.template.ts
    payment-approved.template.ts
    payment-declined.template.ts
    order-confirmed.template.ts
    order-cancelled.template.ts
    notification-templates.ts                    # +6 entradas
    (specs colocados junto a cada archivo)
apps/notifications/test/events.e2e-spec.ts       # + los seis eventos y el fan-out
apps/api/test/notification-bridge.e2e-spec.ts    # + los seis eventos
apps/api/test/notification-flow.e2e-spec.ts      # checkout → pago → avisos (nuevo)
```

Cada carpeta se crea solo cuando tiene contenido. No hace falta ninguna carpeta fuera de la lista de `CLAUDE.md`.

## Plan de implementación

Cada paso deja el sistema compilando y con `npm test` en verde, es commiteable por separado y no supera 30–50 líneas de código de producción (sin contar specs).

1. **`storeIds` en `order.confirmed`.** Ampliar `OrderConfirmedPayload`; en `handlePaymentApproved` leer los `sub_orders` dentro de la sesión y pasarlos a `OutboxService.add`. Verificar que `catalog` ignora el campo nuevo. Specs: el outbox guarda `storeIds` sin repetidos, un pedido de dos tiendas guarda ambas, un pedido sin `sub_orders` no se confirma. Actualizar los specs y e2e de `order` que comparan el payload.
2. **`buyerId` en `payment.*`.** Ampliar `PaymentApprovedPayload` y `PaymentDeclinedPayload`, `EmittablePayment` y `buildEnvelope`; asegurar que la reemisión trae `buyerId`. Specs: el sobre de ambos eventos lleva `buyerId`, la reemisión conserva `eventId` y `buyerId`. Ajustar los fixtures de `order` y los e2e de `payments`.
3. **Lista blanca.** Añadir las seis filas a `ALLOWED_FIELDS`. Specs: cada tipo conserva solo sus campos, `email` y `motivo` nunca salen, `order.created` sigue rechazado.
4. **Listener de eventos con sobre.** Crear `services/bridge-envelope-listener.service.ts` con `@OnEvent` de los cuatro tipos: reutiliza `eventId`, `occurredAt` y `correlationId`, filtra e inserta. Importar los nombres solo desde `modules/order/index.js` y `modules/payments/index.js`. Specs: conserva el `eventId` del sobre, 11000 se ignora, otro error se relanza, el mismo evento dos veces deja un documento.
5. **Listener de eventos de `auth`.** Ampliar `bridge-listener.service.ts` con `user.registered` y `provider.rejected`. Specs: genera `eventId` nuevo, `correlationId = userId`, el `email` no se guarda, 11000 y otros errores como en `provider.approved`.
6. **Registro del transporte.** Ampliar `NOTIFIABLE_EVENTS` y la prueba de `declareTopology` (un enlace por cada uno de los siete tipos). Registrar el listener nuevo en `NotificationBridgeModule`.
7. **Utilidades de plantillas.** Crear `templates/payload.ts` (`requireObjectId`, `requireObjectIdList`, `formatCop`, `InvalidEventPayloadError`) y migrar `provider-approved.template.ts` sin cambiar su resultado. Specs: id válido e inválido, lista vacía o con repetidos, `formatCop(1250000)` es `$1.250.000`, un monto decimal o negativo lanza.
8. **Plantillas de `auth`.** `user-registered.template.ts` (dos textos según `rol`) y `provider-rejected.template.ts` (con y sin `reason`, recorte a 200). Ampliar `PLANTILLAS` y registrar ambas. Specs de cada caso, incluido un `rol` no esperado que lanza.
9. **Plantillas de `payments`.** `payment-approved.template.ts` y `payment-declined.template.ts`. Registrarlas. Specs: destinatario `buyerId`, monto formateado, el `motivo` nunca aparece en el mensaje.
10. **Plantillas de `order`.** `order-confirmed.template.ts` (1 + N borradores, tipos `USER` y `STORE`) y `order-cancelled.template.ts` (un texto por `motivo`, otro valor lanza). Registrarlas. Specs: un pedido de dos tiendas da tres borradores; `storeIds` vacío o con id inválido lanza; los cuatro motivos.
11. **Servicio con varios avisos.** Reescribir `handle` para insertar con `insertMany` (`ordered: false`) y tratar 11000 por borrador. Specs: tres avisos se guardan, un reintento con uno ya guardado crea los otros dos y no duplica, un error distinto de 11000 se relanza.
12. **E2E de `notifications`.** Ampliar `events.e2e-spec.ts` contra MongoDB y RabbitMQ reales: cada uno de los seis tipos publicado en el exchange deja el aviso esperado; `order.confirmed` con dos tiendas deja tres `Notification`; el mismo `eventId` dos veces no duplica; `order.cancelled` con un `motivo` desconocido llega a la DLQ tras 3 entregas.
13. **E2E del puente.** Ampliar `notification-bridge.e2e-spec.ts` con una cola de prueba: registrar un PROVEEDOR deja `user.registered` sin `email`; rechazarlo deja `provider.rejected`; los eventos de `order` y `payments` salen con el `eventId` original.
14. **E2E del flujo.** Crear `notification-flow.e2e-spec.ts`: un PRODUCTOR hace checkout de dos tiendas y paga con el token de aprobación del simulador; con `api` y `notifications` corriendo, quedan `payment.approved` y `order.confirmed` publicados y, en `mini-croper-notifications`, un aviso al productor por el pago, otro por el pedido y uno por tienda. Un pago rechazado deja `payment.declined` y ningún `order.confirmed`.
15. **Verificación de punta a punta y documentación.** Probar a mano con `docker compose up -d --wait` y las dos apps; actualizar `docs/reglas-de-negocio.md` (tabla de eventos, "avisa al productor y a cada tienda", "hoy el puente cubre…", historial) y `CLAUDE.md` (eventos cableados, payloads nuevos, quitar "llegan en el SPEC 10").

## Criterios de aceptación

- [ ] `order.confirmed` lleva `storeIds` con una entrada por tienda del pedido, sin repetidos, escrito en el outbox dentro de la misma transacción que confirma el pedido.
- [ ] `catalog` y `order` siguen funcionando con los payloads ampliados: sus specs y e2e pasan.
- [ ] `payment.approved` y `payment.declined` llevan `buyerId`, también cuando los reemite el job.
- [ ] `NOTIFIABLE_EVENTS` tiene exactamente siete tipos y la cola `notifications.events` queda enlazada a todos tras arrancar cualquiera de las dos apps, sin recrearse.
- [ ] Cada uno de los seis eventos nuevos deja un documento en `notification_outbox` con la lista blanca aplicada y termina `PUBLISHED`.
- [ ] Ningún mensaje de RabbitMQ ni documento de `notification_outbox` o `notifications` contiene un `email`, y `payment.declined` no lleva `motivo`.
- [ ] Un evento de `order` o `payments` reenviado con el mismo `eventId` no crea otro documento en `notification_outbox` ni otro `Notification`.
- [ ] Un fallo del puente al guardar un evento de `order` o `payments` se relanza, de modo que el outbox de `order` o la reemisión de `payments` lo reintenta.
- [ ] `user.registered` avisa al usuario con el texto de su `rol`; `provider.rejected` incluye `reason` recortado a 200 caracteres si existe.
- [ ] `payment.approved` y `payment.declined` avisan al `buyerId`; el mensaje de rechazo no muestra el `motivo`.
- [ ] `order.confirmed` de un pedido de N tiendas deja N + 1 avisos: uno `USER` (`ORDER_CONFIRMED_BUYER`) y uno `STORE` (`ORDER_CONFIRMED_STORE`) por tienda.
- [ ] `order.cancelled` avisa solo al productor, con un texto distinto por cada `motivo`; un `motivo` desconocido termina en la DLQ tras 3 entregas.
- [ ] Un reintento de un evento con varios avisos completa los que faltan sin duplicar los guardados.
- [ ] Un `buyerId`, `userId`, `storeId` u `orderId` mal formado, o un `monto` o `total` no entero, termina en la DLQ tras 3 entregas.
- [ ] `order.created` y los eventos `stock.*` siguen sin publicarse hacia `notifications`.
- [ ] Ningún log del puente ni de `notifications` contiene payloads, mensajes de aviso ni emails.
- [ ] `notification-bridge` importa de `auth`, `order` y `payments` solo desde su `index.js`; ningún módulo importa archivos internos de `notification-bridge`.
- [ ] `notification-bridge` y `notifications` no se escriben las colecciones entre sí.
- [ ] Con `api` y `notifications` corriendo, un checkout de dos tiendas pagado con el token de aprobación deja los avisos del pago y del pedido al productor y uno por tienda; un pago rechazado deja solo el aviso de rechazo.
- [ ] `docs/reglas-de-negocio.md` y `CLAUDE.md` reflejan los siete eventos cableados y los payloads nuevos, y el historial tiene una entrada nueva.
- [ ] `npm run build:all`, `npm run lint`, `npm test` y `npm run test:e2e` terminan sin errores.

## Decisiones

- **Sí:** ampliar los payloads en `order` y `payments`. El puente y `notifications` no pueden consultarles, y un campo extra no rompe a sus consumidores.
- **No:** que el puente consulte `OrderQueryService` para sacar `buyerId` y tiendas. Acopla el puente a `order`, añade lecturas al camino del evento y falla si el pedido cambia entre tanto.
- **No:** que `notifications` consulte a `api` por HTTP. Rompe su independencia y exigiría el `/internal/*` con token de servicio, que queda fuera.
- **Sí:** `storeIds` dentro del mismo outbox transaccional de `order.confirmed`. Si no se pueden leer, el pedido no se confirma en vez de avisar a medias.
- **Sí:** reutilizar el `eventId` de los eventos con sobre. Es lo que hace idempotente el reenvío del outbox de `order` y de la reemisión de `payments`.
- **Sí:** una plantilla que devuelve varios avisos. El SPEC 09 ya la dejó como lista y el índice único los admite.
- **Sí:** `insertMany` con `ordered: false` y 11000 por borrador. Un evento con tres avisos puede fallar a la mitad; el reintento debe completarlo, no darlo por hecho.
- **No:** guardar un solo aviso por evento con todos los destinatarios dentro. Cada aviso es de un destinatario y se leerá por él (índice por destinatario).
- **Sí:** `order.cancelled` solo al productor. Las tiendas no habían visto el pedido como firme.
- **No:** avisar de la cancelación a las tiendas. Habría que ampliar el payload y decidir qué ven de un pedido que nunca confirmaron.
- **Sí:** no reenviar `motivo` de `payment.declined`. Es un código de la pasarela; no aporta al usuario y es una superficie más de datos.
- **Sí:** reenviar `reason` de `provider.rejected`, recortado. Es la razón que el proveedor necesita para corregir su solicitud.
- **No:** reenviar el `email` para "avisar por correo". El envío real está fuera de alcance y los avisos van por `userId`.
- **Sí:** mantener `payment.approved` y `order.confirmed` como avisos separados al productor. Un pago tardío sobre un pedido vencido deja solo el primero, que es justo lo que el productor debe saber.
- **Sí:** `orderId` en el texto del aviso. Sin endpoint de lectura es la única referencia que el usuario puede dar.
- **Sí:** `docs/reglas-de-negocio.md` y `CLAUDE.md` se actualizan al implementar (paso 15), no al escribir este spec.

## Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Un `order.confirmed` ya guardado en el outbox de `order` antes del despliegue no trae `storeIds` | El puente lo filtra y la plantilla lanza `InvalidEventPayloadError`: el mensaje llega a la DLQ. Los pedidos confirmados antes del despliegue no se notifican. Aceptado: no hay datos de producción. |
| `reason` es texto libre del ADMIN y podría contener datos personales | Se recorta a 200 caracteres y el mensaje solo va al propio usuario. Si no basta, se cambia por un catálogo de motivos en otro spec. |
| Un aviso a una tienda no se puede leer: no hay endpoint y la tienda no tiene canal | Aceptado, igual que en el SPEC 09. Los avisos quedan guardados y simulados; la lectura va en otro spec. |
| Con `emitAsync`, una excepción del puente en un evento de `order` hace reintentar a los demás listeners (`catalog`) | Todos son idempotentes por `eventId` (`processed_events`, `order_processed_events`). El puente solo relanza un error real, nunca el 11000. |
| El mismo pago aprobado emitido dos veces por la reemisión duplicaría avisos | Mismo `eventId` en la reemisión: se ignora en `notification_outbox` y en el índice único de `notifications`. |
| Un aviso parcial (fallo a mitad de `insertMany`) | El mensaje se reentrega (hasta 3 veces) y `handle` completa los que faltan sin duplicar. |
| Un pedido de muchas tiendas produce muchos avisos por evento | El límite del carrito es de 50 líneas, así que `storeIds` es acotado; `insertMany` lo resuelve en una operación. |
| Cualquiera con `RABBITMQ_URI` puede publicar un evento falso | Heredado del SPEC 09; las credenciales por servicio van con el despliegue. |

## Notas de implementación

Diferencias entre el plan y lo implementado (2026-11-09):

- **`handle` no cambió a `insertMany`.** El `NotificationsService` del SPEC 09 ya hacía un `create` por borrador y trataba el 11000 por borrador, que es justo el comportamiento pedido; solo se añadieron specs del reintento parcial. El efecto es el mismo (los que faltan se crean, los repetidos se ignoran).
- **Lógica común del puente en `services/outbox-enqueue.ts`.** Ambos listeners (`BridgeListenerService` para `auth` y `BridgeEnvelopeListenerService` para `order` y `payments`) la usan: lista blanca, 11000 ignorado, otros errores registrados sin payload y relanzados.
- **`templates/payload.ts`** además exporta `requireMonto` (entero no negativo), que usan las plantillas de pago y de `order.confirmed`.
- **E2E del flujo:** `api` y `notifications` corren como dos aplicaciones Nest en el mismo proceso de Vitest (no como dos procesos); cubre checkout de dos tiendas, pago aprobado y pago rechazado.
- **Paso 14 manual:** no se repitió a mano con `node dist/...` porque el e2e del flujo cubre el mismo recorrido contra MongoDB y RabbitMQ reales.
- **E2E existentes:** `auth`, `catalog`, `order` y `payments` ahora también borran sus documentos de `notification_outbox`; en `notification-bridge`, `outboxOf` y `messageFor` filtran por tipo porque un mismo usuario genera ahora dos eventos (`user.registered` y `provider.approved`).
- **Pendiente heredado:** los e2e comparten la cola real `notifications.events`, así que el consumidor de las suites de `notifications` y del flujo también guarda avisos de eventos de otras suites; esos avisos quedan en `mini-croper-notifications` (datos de prueba).

## Qué **no** está en este spec

- Aviso de cancelación a las tiendas y aviso al `ADMIN`.
- Email, SMS o push reales.
- Endpoints de lectura de avisos, `/internal/*` y su token de servicio.
- Reproceso de la DLQ y de eventos `FAILED`, y limpieza (TTL) de colecciones.
- Preferencias de usuario, plantillas editables y localización.
- Notificaciones de `order.created`, `stock.*` y `store.created`.
- Credenciales por servicio, TLS y despliegue de RabbitMQ en producción.

Cada uno de estos, si se aborda, va en su propio spec.
