# SPEC 08 — Módulo Payments (pago simulado, idempotencia, webhook firmado y eventos)

> **Status:** Aprobado
> **Depends on:** SPEC 03, SPEC 04, SPEC 07
> **Date:** 2026-11-07
> **Objective:** Implementar el módulo `payments` del monolito `api` (`POST /payments` idempotente con monto tomado de `order`, simulador de pasarela, webhook firmado por HMAC, historial de intentos y eventos `payment.approved` y `payment.declined`).

## Por qué existe este spec

`docs/reglas-de-negocio.md` ("Pagos" y "Tokens de prueba del simulador") fija las reglas, pero hoy `payments` es un esqueleto con un endpoint de ejemplo. El spec 07 ya espera `payment.approved` y `payment.declined`, y expone `OrderQueryService.getOrderForPayment`.

Decisiones no obvias que este spec cierra:

- **La idempotencia vive en el propio `Payment`.** La clave (`idempotencyKey`) y el hash del cuerpo (`requestHash`) se guardan en el pago, sin colección aparte y sin TTL. Un reintento reconstruye la respuesta desde el `Payment`.
- **Un solo pago activo por pedido.** Un índice único parcial sobre `orderId` impide dos cobros en vuelo. Solo se reintenta tras `DECLINED` o `ERROR`.
- **Los eventos de pago no usan el outbox.** El outbox es propiedad de `order` y solo produce `order.*` (spec 07). `payments` emite en memoria con `emitAsync` después de confirmar el cambio en Mongo. Un job reemite los pagos finales cuyo evento no quedó marcado como emitido. `order` es idempotente por `eventId`.
- **Pago tardío.** El webhook marca el pago `APPROVED` aunque el pedido ya haya vencido o esté cancelado. `order` decide: confirma si sigue en `AWAITING_PAYMENT` o ignora con `warn` (spec 07). El cobro huérfano queda como riesgo aceptado.
- **Firma sobre el cuerpo crudo.** El HMAC se calcula sobre `${timestamp}.${rawBody}`, así que la app necesita el cuerpo sin parsear.
- **Huecos de las reglas** que este spec fija y que `docs/reglas-de-negocio.md` debe recoger al implementar (último paso):
  - Qué hace el webhook con un pago ya resuelto: `200` sin cambios.
  - Si `ERROR` puede llegar por webhook: sí.
  - El pago tardío (arriba).

## Alcance

**Dentro:**

- **Colecciones propias de `payments`** (Mongoose, base `mini-croper`): `payments`, `payment_attempts` y `payment_processed_events`, con sus índices.
- **`POST /payments`** (rol `PRODUCTOR`, header `Idempotency-Key`): monto desde `order`, solo pedidos `AWAITING_PAYMENT` propios y vigentes.
- **Simulador de pasarela** aislado tras el token de inyección `PAYMENT_GATEWAY`, con latencia de 1 a 3 s y los cinco resultados de la tabla de tokens.
- **Webhook** `POST /payments/webhook` (`@Public()`, autenticado por firma HMAC-SHA256 y timestamp) que resuelve pagos `PROCESSING`.
- **`PaymentAttempt`:** cada intento queda registrado, aprobado o no.
- **Eventos** `payment.approved` y `payment.declined` en memoria, con job de reemisión cada 10 s.
- **Consultas:** `PRODUCTOR` sus pagos; `ADMIN` todos, en solo lectura y con el historial de intentos.
- **Rate limiting:** 10 peticiones por minuto en `/payments` con `@Throttle`.
- **Variable de entorno nueva:** `PAYMENTS_WEBHOOK_SECRET`, validada con Zod en `apiEnvSchema`.
- **Habilitar el cuerpo crudo** (`rawBody: true`) en la creación de la app de `api` para verificar la firma.
- **API pública de `index.ts`:** `PaymentsModule`, `PaymentEvents` y los tipos de sus eventos.
- **Validación:** DTO `z.strictObject` con `StandardSchemaValidationPipe` global.
- **Documentación:** actualizar `docs/reglas-de-negocio.md` y `CLAUDE.md`.

**Fuera de alcance (para specs futuros):**

- Pagos reales, crédito y PCI DSS.
- Reembolsos y gestión de pagos huérfanos.
- Conciliación.
- El transporte de eventos hacia `notifications` (RabbitMQ u otro) y la DLQ.
- Endpoints `/internal/*`.
- Recuperación de pagos `PROCESSING` huérfanos (proceso caído durante la simulación).
- Cancelar pagos `PROCESSING` cuando el pedido expira: `payments` no consume `order.cancelled`.
- Un consumidor real de `payment.*` en `notifications`.
- Limpieza (TTL) de `payment_attempts` y `payment_processed_events`.

## Modelo de datos

Colecciones propias de `payments`. Ningún otro módulo las lee directamente. Los montos son enteros en COP, sin decimales. Los identificadores de código no llevan tildes.

```ts
// schemas/payment.schema.ts → colección `payments`
type Payment = {
  _id: ObjectId;
  orderId: ObjectId;
  buyerId: ObjectId; // User PRODUCTOR
  monto: number; // order.total, nunca del cliente
  moneda: 'COP';
  metodo: 'CARD' | 'PSE' | 'NEQUI';
  status: 'PENDING' | 'PROCESSING' | 'APPROVED' | 'DECLINED' | 'ERROR';
  referencia?: string; // la asigna la pasarela: `SIM-<uuid>`
  motivoRechazo?: string; // 'INSUFFICIENT_FUNDS' | 'INVALID_TOKEN' | 'GATEWAY_ERROR' | motivo del webhook
  idempotencyKey: string; // header Idempotency-Key
  requestHash: string; // SHA-256 hex de `orderId|metodo|token`
  eventId?: string; // uuid v4 estable del evento; se fija al pasar a estado final
  eventEmittedAt?: Date; // marca de que `order` procesó la emisión
  eventAttempts: number; // default 0; intentos de reemisión
  finalizedAt?: Date; // instante del estado final
  createdAt: Date;
  updatedAt: Date;
};

// schemas/payment-attempt.schema.ts → colección `payment_attempts`
type PaymentAttempt = {
  _id: ObjectId;
  paymentId: ObjectId;
  orderId: ObjectId;
  buyerId: ObjectId;
  origen: 'SIMULATOR' | 'WEBHOOK';
  resultado: 'APPROVED' | 'DECLINED' | 'ERROR' | 'PROCESSING';
  motivo?: string;
  createdAt: Date; // sin token, sin firma, sin cuerpo crudo
};

// schemas/processed-event.schema.ts → colección `payment_processed_events`
type ProcessedEvent = {
  _id: ObjectId;
  eventId: string; // eventId del webhook; índice único
  processedAt: Date;
};
```

El token de prueba nunca se guarda: solo entra en el cálculo de `requestHash`.

Índices:

| Colección | Índice |
| --- | --- |
| `payments` | `{ buyerId: 1, idempotencyKey: 1 }` único |
| `payments` | `{ orderId: 1 }` único parcial con `partialFilterExpression: { status: { $in: ['PENDING', 'PROCESSING', 'APPROVED'] } }`: un solo pago activo o aprobado por pedido |
| `payments` | `{ buyerId: 1, createdAt: -1 }`; `{ status: 1, createdAt: -1 }`; `{ status: 1, eventEmittedAt: 1, finalizedAt: 1 }` |
| `payment_attempts` | `{ paymentId: 1, createdAt: 1 }` |
| `payment_processed_events` | `{ eventId: 1 }` único |

Un error 11000 en `POST /payments` se resuelve así: se vuelve a leer `(buyerId, idempotencyKey)`. Si existe, es un doble clic simultáneo y se devuelve ese pago con `200`. Si no existe, el conflicto es el del índice parcial y responde `409` con `{ code: 'PAYMENT_IN_PROGRESS' }`.

El índice parcial con `$in` exige MongoDB 6.0 o superior (ver Riesgos).

### Estados y transiciones

```text
PENDING → PROCESSING → APPROVED
                    ├→ DECLINED
                    └→ ERROR
```

| Transición | Disparador | Condición de la actualización |
| --- | --- | --- |
| (nuevo) → `PENDING` | `POST /payments` | — |
| `PENDING` → `PROCESSING` | antes de llamar a la pasarela | `{ status: 'PENDING' }` |
| `PROCESSING` → `APPROVED` / `DECLINED` / `ERROR` | respuesta de la pasarela o webhook | `{ status: 'PROCESSING' }` |

`APPROVED`, `DECLINED` y `ERROR` son finales. Una excepción inesperada de la pasarela deja el pago en `ERROR` con motivo `GATEWAY_ERROR`. La regla pura vive en `policies/payment-state.policy.ts`.

### Simulador de pasarela

El contrato vive en `services/payment-gateway.ts` y el simulador en `services/simulated-gateway.service.ts`. Se inyecta con el token `PAYMENT_GATEWAY`, así que sustituirlo por una pasarela real solo cambia el provider.

```ts
interface PaymentGateway {
  charge(input: {
    monto: number;
    moneda: 'COP';
    metodo: 'CARD' | 'PSE' | 'NEQUI';
    token: string;
  }): Promise<{
    resultado: 'APPROVED' | 'DECLINED' | 'ERROR' | 'PROCESSING';
    referencia: string;
    motivo?: string;
  }>;
}
```

`policies/gateway-token.policy.ts` mapea el token al resultado (función pura):

| Token | Resultado | `motivo` |
| --- | --- | --- |
| `tok_test_approved` | `APPROVED` | — |
| `tok_test_declined` | `DECLINED` | `INSUFFICIENT_FUNDS` |
| `tok_test_error` | `ERROR` | `GATEWAY_ERROR` |
| `tok_test_pending` | `PROCESSING` | — |
| cualquier otro | `DECLINED` | `INVALID_TOKEN` |

La latencia es un entero aleatorio entre 1000 y 3000 ms antes de responder (`randomLatencyMs(random)` en la misma policy). El simulador no persiste nada: lo hace `PaymentsService`.

### Variables de entorno nuevas

Se suma a `apiEnvSchema` en `libs/common/src/config/env.schema.ts`:

```ts
PAYMENTS_WEBHOOK_SECRET: z.string().min(32),
```

| Variable | Obligatoria | Nota |
| --- | --- | --- |
| `PAYMENTS_WEBHOOK_SECRET` | Sí | Secreto compartido del HMAC del webhook; mínimo 32 caracteres. Sin ella `api` no arranca y el error nombra la variable |

`.env.example` la incluye con un valor de ejemplo claramente falso.

### `POST /payments`

Rol `PRODUCTOR`. Header `Idempotency-Key` obligatorio (string de 8 a 100 caracteres). Cuerpo (`z.strictObject`):

```ts
{ orderId: ObjectId, metodo: 'CARD' | 'PSE' | 'NEQUI', token: string /* 1..100 */ }
```

Cualquier token se acepta en el DTO; uno desconocido lo rechaza el simulador como `DECLINED`. El cliente nunca envía monto ni datos de tarjeta.

Flujo:

1. Calcula `requestHash` (`policies/request-hash.policy.ts`) y busca `(buyerId, idempotencyKey)`. Si existe y el hash coincide, devuelve ese pago con `200` (misma respuesta). Si el hash difiere, `422`. Esta comprobación va antes de mirar el pedido, que puede haber cambiado.
2. `OrderQueryService.getOrderForPayment(orderId, buyerId)`. `null` es `404`. Un `status` distinto de `AWAITING_PAYMENT`, o un `expiresAt` ya pasado aunque el job no haya cancelado el pedido, es `409` con `{ code: 'ORDER_NOT_PAYABLE' }`.
3. Inserta el `Payment` en `PENDING` con `monto = order.total`. Un conflicto de índice se resuelve como arriba.
4. Pasa a `PROCESSING` y llama a `PAYMENT_GATEWAY.charge`. La petición espera la latencia de 1 a 3 s y responde con el resultado.
5. En una transacción de Mongo (`connection.startSession()`): actualización condicional del `Payment` (`PROCESSING` → estado final, con `referencia`, `motivoRechazo`, `eventId`, `finalizedAt`) e insert del `PaymentAttempt`. Con `tok_test_pending` no hay estado final: el pago sigue en `PROCESSING` y solo se inserta el intento con `resultado: 'PROCESSING'`.
6. Fuera de la transacción emite el evento (ver "Eventos") y responde.

Respuesta: `201` en el primer intento y `200` en un reintento con la misma clave. El cuerpo es `{ id, orderId, monto, moneda, metodo, status, referencia, motivoRechazo, createdAt }`, nunca `idempotencyKey`, `requestHash` ni token. Un pago `DECLINED` o `ERROR` también responde `201`: el recurso se creó y el resultado va en `status`. Un reintento con la misma clave de un pago final devuelve ese mismo resultado; para volver a intentar el cobro se usa una clave nueva.

Un reintento con la misma clave mientras el original sigue en la pasarela devuelve el estado actual (`PROCESSING`).

### Webhook

`POST /payments/webhook`. Es `@Public()` porque no lleva JWT: se autentica solo por firma. Headers `X-Signature` (HMAC-SHA256 en hexadecimal) y `X-Timestamp` (segundos Unix). Sigue contando para el límite de 10 peticiones por minuto por IP.

Firma: `HMAC-SHA256(PAYMENTS_WEBHOOK_SECRET, `${timestamp}.${rawBody}`)`. La verificación vive en `policies/webhook-signature.policy.ts` (función pura con secreto, timestamp, cuerpo crudo, firma y `now`):

1. Faltan headers, el timestamp no es un entero o la firma no es hexadecimal de 64 caracteres: `401`.
2. `|now − timestamp| > 300 s`: `401`.
3. La firma se compara con `crypto.timingSafeEqual` (tras comprobar longitudes iguales). Si no coincide: `401`.

Todos los `401` devuelven el mismo mensaje genérico; no indican cuál comprobación falló.

La firma se verifica **antes** de validar el cuerpo. Por eso el controlador recibe `@Req() req: RawBodyRequest<Request>` y parsea el cuerpo con el schema del DTO (`safeParse`, `400` si falla) después de la firma, en lugar de `@Body({ schema })`.

Cuerpo:

```ts
z.strictObject({
  eventId: z.uuid(),
  paymentId: ObjectId,
  resultado: z.enum(['APPROVED', 'DECLINED', 'ERROR']),
  motivo: z.string().max(200).optional(),
});
```

Flujo, en una transacción:

1. Inserta `eventId` en `payment_processed_events`. Si ya existe (código 11000), responde `200` sin cambios: protección contra repetición.
2. Si el `Payment` no existe: `404`.
3. Actualización condicional `{ status: 'PROCESSING' }` al `resultado` recibido, más el `PaymentAttempt` con `origen: 'WEBHOOK'`. Si el pago ya estaba resuelto, no modifica nada y responde `200` sin cambios (el `eventId` queda marcado).
4. Tras confirmar, emite el evento como en `POST /payments`. No consulta el estado del pedido: aunque haya vencido o esté cancelado, el pago queda `APPROVED` y `order` decide (ver "Por qué existe este spec").

La respuesta es `200` con `{ status: 'OK' }` en todos los casos aceptados.

### Eventos

Se usa el sobre `DomainEvent` (`{ eventId, type, occurredAt, correlationId, payload }`) que `payments` importa desde `modules/order/index.js`. El `correlationId` es el id del pedido. Los payloads son los que fijó el spec 07 y no se reinterpretan.

Nombres en `events/payments.events.ts`:

```ts
export const PaymentEvents = {
  PaymentApproved: 'payment.approved',
  PaymentDeclined: 'payment.declined',
} as const;

// Fijados por el spec 07 (se importan de modules/order/index.js)
type PaymentApprovedPayload = { orderId: string; paymentId: string; monto: number };
type PaymentDeclinedPayload = { orderId: string; paymentId: string; motivo: string };
```

| Estado final del `Payment` | Evento |
| --- | --- |
| `APPROVED` | `payment.approved` |
| `DECLINED` o `ERROR` | `payment.declined` con `motivo = motivoRechazo` |

Consumidores: `order` (saga del spec 07) y `notification`. Este spec no implementa ningún consumidor: el de `notification` depende del transporte, que no está decidido.

Consistencia (distinta del outbox de `order`):

- **Transaccional:** el cambio de estado del `Payment`, su `eventId` y el `PaymentAttempt` se escriben en una sola transacción.
- **No transaccional:** la emisión es `EventEmitter2.emitAsync(type, envelope)` después del commit. Si tiene éxito, se fija `eventEmittedAt`. Si falla, el pago queda sin marca y no falla la petición HTTP; se registra un log `error` sin payload.
- **Reemisión:** `services/payment-events.service.ts` corre con `@Interval(10000)`. Busca `Payment` en estado final, sin `eventEmittedAt`, con `finalizedAt` anterior a 10 s y `eventAttempts < 5`. Reemite con el mismo `eventId` y suma `eventAttempts` en cada intento. Al llegar a 5 deja de reintentar (queda visible en el documento).
- **Entrega al menos una vez:** `order` ignora los `eventId` ya procesados (spec 07), así que una reemisión no repite la transición.
- `@nestjs/schedule` ya lo incorpora el spec 07 con `ScheduleModule.forRoot()`; `payments` solo usa `@Interval`.

### Propiedad y visibilidad

| Rol | Puede | No puede |
| --- | --- | --- |
| `PRODUCTOR` | `POST /payments`, `GET /payments` y `GET /payments/:id` de **sus** pagos | Ver pagos ajenos (`404`) |
| `ADMIN` | `GET /payments/admin` y `/:id` de todos los pagos, solo lectura | Crear pagos (`403` por rol) |
| `PROVEEDOR` | — | Cualquier endpoint de `/payments` (`403`) |

### Endpoints

Los ids de ruta se validan como ObjectId de 24 caracteres hexadecimales. Todos son privados salvo el webhook.

| Método y ruta | Rol | Notas |
| --- | --- | --- |
| `POST /payments` | PRODUCTOR | Ver "`POST /payments`". |
| `GET /payments` | PRODUCTOR | Query `page` (≥ 1), `limit` (defecto 20, máx. 100), `status?`, `orderId?`; orden `createdAt` descendente. |
| `GET /payments/:id` | PRODUCTOR | Pago propio; ajeno: `404`. |
| `GET /payments/admin` | ADMIN | Misma paginación; filtros `status?`, `buyerId?` y `orderId?`. |
| `GET /payments/admin/:id` | ADMIN | Detalle con sus `PaymentAttempt` (`origen`, `resultado`, `motivo`, `createdAt`). |
| `POST /payments/webhook` | `@Public()` | Ver "Webhook". |

La respuesta paginada es `{ data, page, limit, total }`. Ninguna respuesta incluye `idempotencyKey`, `requestHash` ni token. `PaymentsAdminController` se declara antes que `PaymentsController` en el módulo, para que `admin` no se confunda con `:id`.

Todos los controladores llevan `@Throttle({ default: { limit: 10, ttl: 60_000 } })`, que sobrescribe el límite global de 100 por minuto.

### Datos sensibles

- El sistema nunca recibe ni guarda datos de tarjeta; solo el token de prueba, que además no se persiste.
- Los logs no incluyen tokens de pago, firmas, el secreto del webhook ni el cuerpo crudo. Pueden incluir `paymentId`, `orderId` y el estado.
- Los `PaymentAttempt` y `lastError` no guardan el token.

### API pública de `index.ts`

```ts
export { PaymentsModule } from './payments.module.js';
export {
  PaymentEvents,
  type PaymentApprovedPayload,
  type PaymentDeclinedPayload,
} from './events/payments.events.js';
```

Propósito: `ApiModule` importa `PaymentsModule`, y `notification` usará `PaymentEvents` y los tipos para consumir los eventos. Los tipos de payload se reexportan de `modules/order/index.js`, donde los fijó el spec 07. `payments` importa `OrderQueryService` y `OrderModule` solo desde `modules/order/index.js`; no habla con `catalog`.

### Estructura de archivos

```text
apps/api/src/modules/payments/
  index.ts
  payments.module.ts
  controllers/
    payments.controller.ts            # POST /payments, GET /payments y /:id
    payments-admin.controller.ts      # /payments/admin
    payments-webhook.controller.ts    # POST /payments/webhook
  services/
    payments.service.ts               # idempotencia, validación de pedido, estados
    payments-query.service.ts         # consultas por rol
    payment-gateway.ts                # interfaz PaymentGateway y token PAYMENT_GATEWAY
    simulated-gateway.service.ts      # simulador
    webhook.service.ts                # firma, repetición y resolución
    payment-events.service.ts         # emisión y job de reemisión
  dto/
    create-payment.dto.ts
    payment-query.dto.ts
    webhook.dto.ts
  schemas/
    payment.schema.ts
    payment-attempt.schema.ts
    processed-event.schema.ts
  events/
    payments.events.ts
  policies/
    payment-state.policy.ts
    gateway-token.policy.ts
    webhook-signature.policy.ts
    request-hash.policy.ts
  tests/                              # todos los *.spec.ts, planos
apps/api/test/
  payments.e2e-spec.ts
```

`payments.controller.ts`, `payments.service.ts` y `payments.controller.spec.ts` del esqueleto se reescriben con `git mv` donde corresponda. Cada carpeta se crea solo cuando tiene contenido. No hace falta ninguna carpeta fuera de la lista de `CLAUDE.md`.

## Plan de implementación

Cada paso deja el sistema compilando y con `npm test` en verde, es commiteable por separado y no supera 30–50 líneas de código de producción (sin contar specs).

1. **Contratos y estados.** Crear `events/payments.events.ts` y `policies/payment-state.policy.ts` (transiciones permitidas). Specs: transiciones válidas e inválidas; los estados finales no cambian.
2. **Policy del simulador.** Crear `policies/gateway-token.policy.ts` con los cinco resultados y `randomLatencyMs`. Specs: cada token, token desconocido, latencia siempre entre 1000 y 3000.
3. **Policies de firma y hash.** Crear `policies/webhook-signature.policy.ts` y `policies/request-hash.policy.ts`. Specs: firma válida, firma alterada, timestamp a ±300 s y fuera de rango, headers ausentes, longitud distinta, hash estable y distinto ante otro token.
4. **Variable de entorno.** Añadir `PAYMENTS_WEBHOOK_SECRET` a `apiEnvSchema`, a `.env.example` y a los entornos de los specs y e2e existentes que llaman a `validateApiEnv`. Specs: falta, menos de 32 caracteres y válida (patrón de `env.schema.spec.ts`).
5. **Schemas e índices.** Crear los tres schemas con sus índices (incluido el parcial) y registrarlos con `MongooseModule.forFeature`. Spec de defaults e índices (patrón de `auth/tests/schemas.spec.ts`).
6. **DTO.** Crear los tres archivos de `dto/`: ObjectId, `metodo`, `token` 1..100, paginación (`limit` máx. 100), webhook. Specs: rechaza propiedades de más, `{"$ne": null}`, `metodo` desconocido y `limit` 101.
7. **Pasarela.** Crear `payment-gateway.ts` y `SimulatedGatewayService` y registrarlos con `{ provide: PAYMENT_GATEWAY, useClass: ... }`. Specs con temporizadores falsos: espera entre 1 y 3 s y devuelve el resultado del token, con `referencia` `SIM-<uuid>`.
8. **Emisión de eventos.** `PaymentEventsService.emit(payment)`: construye el `DomainEvent`, usa `emitAsync`, marca `eventEmittedAt` y registra el fallo sin payload. Specs con `EventEmitter2` simulado: `APPROVED`, `DECLINED`, `ERROR`, y fallo que no marca.
9. **Alta idempotente y validación del pedido.** `PaymentsService.create` hasta el insert en `PENDING`: replay por `(buyerId, idempotencyKey)`, `422` con otro hash, `404`, `409 ORDER_NOT_PAYABLE` (estado y `expiresAt`), `409 PAYMENT_IN_PROGRESS`. Specs de cada rama con `OrderQueryService` simulado.
10. **Cobro y cierre.** Completar `create`: `PROCESSING`, `PAYMENT_GATEWAY.charge`, transacción con estado final y `PaymentAttempt`, emisión y `POST /payments` en `payments.controller.ts` (`@Roles(Role.PRODUCTOR)`, `@Throttle`, `201` o `200`). Specs: los cinco tokens, `tok_test_pending` deja `PROCESSING`, excepción de la pasarela deja `ERROR`, monto igual a `order.total`, el cuerpo no puede fijar el monto.
11. **Webhook.** Activar `rawBody: true` en la creación de la app (`apps/api/src/main.ts` y el arranque de los e2e), crear `WebhookService` y `payments-webhook.controller.ts` (`@Public()`, `@Throttle`). Specs: firma válida resuelve, firma o timestamp inválidos devuelven `401` sin tocar Mongo, `eventId` repetido devuelve `200`, pago ya resuelto devuelve `200` sin cambios, `ERROR` por webhook, pago inexistente `404`.
12. **Reemisión.** `PaymentEventsService.reemit` con `@Interval(10000)`: pagos finales sin `eventEmittedAt`, con `finalizedAt` anterior a 10 s y menos de 5 intentos. Specs: reemite con el mismo `eventId`, marca al tener éxito, se detiene al quinto intento, no toca pagos ya emitidos.
13. **Consultas del PRODUCTOR.** `PaymentsQueryService.listMine` y `getMine`, `GET /payments` y `GET /payments/:id`. Specs: ajeno `404`, paginación, la respuesta no incluye `idempotencyKey` ni `requestHash`.
14. **Consultas del ADMIN.** `payments-admin.controller.ts` con listado filtrado y detalle con `PaymentAttempt`. Specs: filtros, `403` para `PRODUCTOR` y `PROVEEDOR`, detalle con intentos, sin campos sensibles.
15. **API pública.** Completar `index.ts` y registrar `PaymentsModule` en `ApiModule` si el esqueleto aún no lo hace. Spec: el módulo exporta solo lo definido en "API pública".
16. **E2E.** Crear `apps/api/test/payments.e2e-spec.ts` contra MongoDB con `order` y `catalog` reales: pedido `AWAITING_PAYMENT`, pago con `tok_test_approved` y pedido `CONFIRMED`, `Idempotency-Key` repetida, doble clic simultáneo, `tok_test_pending` resuelto por webhook firmado, rechazos del webhook, reintento tras `DECLINED`, visibilidad por rol y límite de 10 por minuto.
17. **Documentación.** Actualizar `docs/reglas-de-negocio.md` (webhook con pago ya resuelto, `ERROR` por webhook, pago tardío, semántica de `Idempotency-Key`, firma y variable `PAYMENTS_WEBHOOK_SECRET`, fecha e historial) y `CLAUDE.md` (lo que exporta `payments` y la variable en la tabla de entorno de `api`).

## Criterios de aceptación

- [ ] Todos los endpoints de `/payments` salvo `POST /payments/webhook` responden 401 sin token.
- [ ] `PROVEEDOR` y `ADMIN` reciben 403 en `POST /payments`; `PRODUCTOR` y `PROVEEDOR` reciben 403 en `/payments/admin*`.
- [ ] `POST /payments` sin `Idempotency-Key` devuelve 400.
- [ ] `POST /payments` con una propiedad de más, un `metodo` desconocido o `{"$ne": null}` devuelve 400.
- [ ] El monto de `Payment` es igual a `order.total`; un `monto` enviado por el cliente devuelve 400.
- [ ] Un pedido inexistente o de otro comprador devuelve 404.
- [ ] Un pedido en `PENDING`, `CONFIRMED` o `CANCELLED` devuelve 409 con `code: ORDER_NOT_PAYABLE`.
- [ ] Un pedido `AWAITING_PAYMENT` con `expiresAt` pasado devuelve 409 con `code: ORDER_NOT_PAYABLE`.
- [ ] Repetir `Idempotency-Key` con el mismo cuerpo devuelve 200 con el mismo `id` y no crea otro `Payment`, otro `PaymentAttempt` ni otro evento.
- [ ] Repetir `Idempotency-Key` con otro `orderId`, `metodo` o `token` devuelve 422.
- [ ] Dos peticiones simultáneas con la misma clave dejan un solo `Payment`.
- [ ] Un pago nuevo con otro `PENDING`, `PROCESSING` o `APPROVED` del mismo pedido devuelve 409 con `code: PAYMENT_IN_PROGRESS`.
- [ ] Un pedido admite un único `Payment` en `APPROVED` (índice único parcial verificado en la base).
- [ ] `tok_test_approved` deja el pago `APPROVED` y emite `payment.approved`.
- [ ] `tok_test_declined` deja el pago `DECLINED` con motivo `INSUFFICIENT_FUNDS` y emite `payment.declined`.
- [ ] `tok_test_error` deja el pago `ERROR` con motivo `GATEWAY_ERROR` y emite `payment.declined`.
- [ ] `tok_test_pending` deja el pago `PROCESSING` y no emite ningún evento.
- [ ] Cualquier otro token deja el pago `DECLINED` con motivo `INVALID_TOKEN`.
- [ ] El simulador tarda entre 1 y 3 s en responder.
- [ ] La pasarela se obtiene por el token `PAYMENT_GATEWAY`; sustituirla no toca `PaymentsService`.
- [ ] Tras `DECLINED` o `ERROR`, un `POST /payments` con otra clave sobre el mismo pedido `AWAITING_PAYMENT` crea un pago nuevo.
- [ ] Cada intento (aprobado, rechazado, con error, `PROCESSING` y por webhook) deja un `PaymentAttempt`, y ninguno contiene el token.
- [ ] El cambio de estado del `Payment` y su `PaymentAttempt` se escriben en una sola transacción: si el insert del intento falla, el pago no cambia de estado.
- [ ] Los eventos usan el formato `{ eventId, type, occurredAt, correlationId, payload }` con el id del pedido como `correlationId` y los payloads del spec 07.
- [ ] Un evento cuya emisión falló se reemite con el mismo `eventId`, se marca `eventEmittedAt` y deja de reemitirse; tras 5 intentos fallidos no se reintenta más.
- [ ] `payments` no escribe en `outbox_events` ni importa archivos internos de `order`.
- [ ] `POST /payments/webhook` con firma válida y timestamp vigente resuelve un pago `PROCESSING` a `APPROVED`, `DECLINED` o `ERROR` y emite el evento correspondiente.
- [ ] El webhook con firma alterada, firma ausente, timestamp ausente o timestamp a más de 300 s devuelve 401 y no modifica ningún dato.
- [ ] El webhook repetido con el mismo `eventId` devuelve 200 y no cambia nada ni emite otro evento.
- [ ] El webhook sobre un pago ya resuelto devuelve 200 sin cambios.
- [ ] El webhook sobre un pedido vencido o cancelado deja el pago `APPROVED` y emite `payment.approved`.
- [ ] La firma se compara con `timingSafeEqual` y la verificación ocurre antes de validar el cuerpo.
- [ ] `PAYMENTS_WEBHOOK_SECRET` ausente o de menos de 32 caracteres impide arrancar `api` y el error nombra la variable.
- [ ] `POST /payments` y el resto de `/payments` devuelven 429 en la petición 11 del mismo minuto desde la misma IP.
- [ ] `GET /payments` devuelve solo pagos del PRODUCTOR autenticado, con `limit` 20 por defecto; `limit=101` devuelve 400.
- [ ] `GET /payments/:id` de un pago ajeno devuelve 404.
- [ ] `GET /payments/admin` lista todos los pagos con filtros `status`, `buyerId` y `orderId`; `GET /payments/admin/:id` incluye los `PaymentAttempt`; `ADMIN` no tiene ningún endpoint que modifique pagos.
- [ ] Ninguna respuesta ni log contiene `idempotencyKey`, `requestHash`, token de pago, firma, secreto ni cuerpo crudo.
- [ ] El sistema no recibe ni guarda datos de tarjeta.
- [ ] `payments` no implementa pagos reales, reembolsos, el transporte hacia `notifications` ni endpoints `/internal/*`.
- [ ] `payments` cumple la estructura de módulo de `CLAUDE.md`: en la raíz solo `index.ts` y `payments.module.ts`; carpetas de la lista estándar y sin vacías; todos los `*.spec.ts` planos en `tests/`; ningún módulo importa archivos internos de `payments`.
- [ ] `docs/reglas-de-negocio.md` documenta las reglas nuevas y tiene entrada nueva en el historial; `CLAUDE.md` refleja lo que exporta `payments` y la variable `PAYMENTS_WEBHOOK_SECRET`.
- [ ] `npm run build:all`, `npm run lint`, `npm test` y `npm run test:e2e` terminan sin errores.

## Decisiones

- **Sí:** la idempotencia se guarda en `Payment` con índice único `{ buyerId, idempotencyKey }` y `requestHash` (SHA-256 de `orderId|metodo|token`), sin TTL. No hace falta otra colección y el reintento reconstruye la respuesta.
- **No:** colección `idempotency_keys` con TTL. Duplicaría el estado del pago.
- **Sí:** misma clave con cuerpo distinto responde `422`. Es un error del cliente que no debe cobrar ni devolver otro pago.
- **Sí:** un reintento con la misma clave responde `200` con el mismo pago; el primer intento responde `201`, incluso si el resultado es `DECLINED` o `ERROR`. El recurso se creó y el resultado va en `status`.
- **Sí:** HMAC-SHA256 hexadecimal sobre `${timestamp}.${rawBody}`, headers `X-Signature` y `X-Timestamp` (segundos Unix), comparado con `timingSafeEqual`. El timestamp firmado impide reutilizar una firma con otra hora.
- **Sí:** tolerancia de ±5 min y `eventId` único en `payment_processed_events` contra repetición. La tolerancia sola no impide reenviar dentro de la ventana.
- **Sí:** `PAYMENTS_WEBHOOK_SECRET` obligatoria, `z.string().min(32)` en `apiEnvSchema`. Sin secreto el webhook estaría abierto.
- **Sí:** `POST /payments/webhook` es `@Public()`: se autentica solo por firma, porque la pasarela no tiene JWT.
- **Sí:** el webhook acepta `APPROVED`, `DECLINED` y `ERROR`, y solo resuelve pagos `PROCESSING`; un pago ya resuelto responde `200` sin cambios. Es idempotente y no revela el estado.
- **Sí:** el webhook marca `APPROVED` aunque el pedido haya vencido o esté cancelado, y emite `payment.approved`. El cobro ya ocurrió y `order` decide con su regla del spec 07.
- **No:** que `payments` consulte el pedido al resolver el webhook. Acopla el pago al estado del pedido tras el cobro.
- **No:** que `payments` consuma `order.cancelled` para cancelar pagos `PROCESSING`. Añadiría un consumidor y otra colección de eventos procesados; el caso queda como riesgo.
- **Sí:** un solo pago activo o aprobado por pedido, con índice único parcial sobre `orderId` y `status` en `PENDING`, `PROCESSING`, `APPROVED`. Impide dos cobros en vuelo.
- **Sí:** los eventos se emiten en memoria con `emitAsync` tras el commit, y un job cada 10 s reemite los pagos finales sin `eventEmittedAt`, con `eventId` estable. El outbox es de `order` (spec 07) y `payments` no lo comparte.
- **No:** `payments_outbox` propio. Duplicaría la infraestructura del spec 07.
- **No:** emisión sin recuperación. Un pago aprobado sin pedido confirmado quedaría abierto.
- **Sí:** `payment.declined` cubre `DECLINED` y `ERROR`, y respeta los payloads del spec 07. Las reglas dicen que ambos dejan el pedido en `AWAITING_PAYMENT`.
- **Sí:** `PRODUCTOR` consulta `GET /payments` y `GET /payments/:id` de sus pagos (ajeno `404`); `ADMIN` consulta `GET /payments/admin` y `/:id` paginado, con filtros y `PaymentAttempt`, solo lectura. Ninguna respuesta incluye `idempotencyKey` ni token.
- **Sí:** pedido inexistente o ajeno es `404`; estado distinto de `AWAITING_PAYMENT` o `expiresAt` ya pasado es `409` con `{ code: 'ORDER_NOT_PAYABLE' }`. No se inicia un cobro nuevo sobre un pedido vencido, aunque el job no lo haya cancelado.
- **Sí:** `POST /payments` es síncrono: responde tras la latencia de 1 a 3 s con el resultado.
- **No:** responder `202` y resolver en segundo plano. Complica al cliente sin necesidad para un simulador.
- **Sí:** un proceso caído durante la simulación deja el pago `PROCESSING` huérfano, sin recuperación en este spec.
- **Sí:** el simulador va tras la interfaz `PaymentGateway` y el token `PAYMENT_GATEWAY`. Permite sustituirlo sin tocar el servicio.
- **Sí:** la firma se verifica antes de validar el cuerpo, con `rawBody: true`. Un cuerpo inválido no revela nada a quien no firma.
- **Sí:** `@Throttle` de 10 por minuto en todos los controladores de `/payments`, con sobrescritura del global de 100. Es el límite de las reglas.
- **Sí:** el token de prueba no se guarda; solo entra en `requestHash`. No hay datos de tarjeta que proteger.
- **Sí:** las reglas de propiedad se aplican en el dominio con `@CurrentUser()`; `PRODUCTOR` solo sus pagos y solo `ADMIN` consulta todos.
- **Sí:** `docs/reglas-de-negocio.md` y `CLAUDE.md` se actualizan al implementar (paso 17), no al escribir este spec.

## Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Pago aprobado tras la cancelación o expiración del pedido (cobro sin pedido) | Aceptado: `order` lo ignora con `warn` (spec 07). Los reembolsos y la gestión de pagos huérfanos quedan fuera de alcance. |
| Proceso caído durante la simulación: el pago queda `PROCESSING` y bloquea el pedido por el índice parcial | Aceptado, sin recuperación en este spec. Es visible en `payments` y en `payment_attempts`. Un spec posterior añade la recuperación. |
| Pago `PROCESSING` cuando el pedido expira: el webhook llega después | El webhook lo marca `APPROVED` y `order` lo ignora con `warn`. Es el mismo caso del cobro huérfano. |
| Caída entre el commit del pago y la emisión del evento | Job de reemisión cada 10 s con el mismo `eventId`; `order` es idempotente. |
| Reemisión agotada (5 intentos) y pedido estancado | Queda visible por `eventAttempts` y sin `eventEmittedAt`. El reproceso manual queda para un spec posterior. |
| `OrderModule` debe exportar `OrderQueryService` para inyectarlo en `payments`; el spec 07 lo expone en `index.ts` pero no lo dice del módulo | Verificar al implementar el paso 9. Si falta, es un cambio mínimo en `order` que debe autorizar el usuario, porque el spec 07 está aprobado. |
| El índice único parcial con `$in` exige MongoDB 6.0 o superior | Comprobar la versión de la imagen de `docker-compose.yml` en el paso 5. Si es anterior, se cambia a un campo booleano `activo`. |
| `rawBody: true` y el límite de 100 kb: un webhook mayor se rechaza | El cuerpo del webhook es de pocos cientos de bytes. |
| Si se filtra `PAYMENTS_WEBHOOK_SECRET`, cualquiera puede aprobar pagos `PROCESSING` | El secreto vive solo en `.env`, con mínimo de 32 caracteres. En un despliegue real se rota con el proveedor de la pasarela. |
| El throttler guarda contadores en memoria y por IP | Heredado de `CLAUDE.md` (una sola instancia, sin `trust proxy`). |
| Las transacciones fallan si MongoDB no corre como replica set | `docker-compose.yml` ya lo levanta como `rs0`; los e2e lo exigen. |
| ESM: imports relativos sin `.js` rompen el build | Seguir la convención del repo (`./archivo.js`). |

## Qué **no** está en este spec

- Pagos reales, crédito y PCI DSS.
- Reembolsos, gestión de pagos huérfanos y conciliación.
- El transporte de eventos hacia `notifications`, la DLQ y el consumidor de `notification`.
- Endpoints `/internal/*`.
- Recuperación de pagos `PROCESSING` huérfanos y cancelación de pagos cuando el pedido expira.
- Limpieza (TTL) de `payment_attempts` y `payment_processed_events`.

Cada uno de estos, si se aborda, va en su propio spec.
