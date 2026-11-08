# SPEC 09 — Notifications: transporte RabbitMQ, puente con outbox y consumidor (un evento de punta a punta)

> **Status:** Aprobado
> **Depends on:** SPEC 02, SPEC 03, SPEC 04, SPEC 07, SPEC 08
> **Date:** 2026-11-08
> **Objective:** Implementar la infraestructura que lleva los eventos de dominio del monolito `api` al servicio `notifications` (RabbitMQ, puente con outbox propio, consumidor con ack manual y DLQ, y colección de avisos) y verificarla de punta a punta con el evento `provider.approved`.

## Por qué existe este spec

`docs/reglas-de-negocio.md` asigna a `notification` siete eventos y habla de *ack* manual y DLQ tras 3 fallos, pero el transporte "aún no está implementado ni decidido" (`CLAUDE.md`) y `apps/notifications` es el esqueleto de Nest (solo `HealthModule` y un `getHello`). Pedir los siete eventos de una vez toca `api` (tres módulos), `notifications`, `libs/common`, `docker-compose.yml` y los e2e, así que se divide en dos specs:

- **SPEC 09 (este):** la infraestructura y un solo evento real, `provider.approved`, que no exige cambiar ningún payload.
- **SPEC 10 (siguiente, no escrito):** plantillas y consumidores de los seis eventos restantes y los cambios de payload que necesitan.

Decisiones no obvias que este spec cierra:

- **RabbitMQ con `amqplib` directo, no `@nestjs/microservices`.** El transporte de Nest espera un sobre propio (`{ pattern, data }`); aquí el contrato del mensaje es el sobre `DomainEvent` de las reglas. `amqplib` vive detrás de un envoltorio en `libs/common/src/messaging/`.
- **Exchange `topic` y cola con *quorum* y límite de entregas.** La DLQ de las reglas ("tras 3 fallos") se implementa con `x-delivery-limit` y un *dead-letter exchange*, sin contador propio.
- **El puente es un módulo del monolito con outbox propio.** `auth` y `payments` emiten en memoria sin outbox, y el outbox de `order` es solo de `order` (spec 07). El puente escucha los eventos en memoria y los guarda en `notification_outbox` antes de publicarlos. Un `eventId` único hace idempotente el reenvío de `order` y `payments`.
- **Lista blanca de campos hacia el exterior.** Los eventos de `auth` llevan `email`. El puente reenvía solo los campos permitidos por tipo de evento, así que el correo nunca sale del monolito ni llega a RabbitMQ (Habeas Data, mínimo de datos). `auth` no cambia.
- **Avisos sin entidades de usuario.** `notifications` no conoce emails: guarda el aviso con destinatario por `userId` o `storeId` y lo "envía" por canal simulado (documento en Mongo y log).
- **Huecos de las reglas** que este spec fija y que `docs/reglas-de-negocio.md` debe recoger al implementar (último paso):
  - Transporte: RabbitMQ; la DLQ deja de estar pendiente.
  - Los eventos hacia `notifications` no llevan datos personales.
  - La entidad `Notification` (hoy "sin entidades").

## Alcance

**Dentro:**

- **RabbitMQ en `docker-compose.yml`** (imagen `rabbitmq:4-management`) y la variable `RABBITMQ_URI`, obligatoria en `api` y en `notifications`.
- **Envoltorio de mensajería** en `libs/common/src/messaging/`: topología (exchange, cola, DLX, DLQ), conexión con reconexión, canal con confirmaciones de publicación y el schema Zod del sobre `DomainEvent`.
- **Módulo `notification-bridge`** en `apps/api/src/modules/` con la forma estándar de `CLAUDE.md`: listener de `provider.approved`, colección `notification_outbox`, job de publicación cada 2 s, lista blanca de campos y publicador tras el token `EVENT_PUBLISHER`.
- **Consumidor en `notifications`:** cola `notifications.events` con *ack* manual, prefetch 10, validación del sobre, idempotencia, reintento por reentrega y DLQ `notifications.events.dlq`.
- **Colección `notifications`** (base `mini-croper-notifications`) y la plantilla de `provider.approved`.
- **Limpieza del esqueleto:** se eliminan `NotificationsController` (hello) y su spec; `main.ts` deja de declarar el tag `notifications` de Swagger.
- **Documentación:** actualizar `docs/reglas-de-negocio.md` y `CLAUDE.md`.

**Fuera de alcance (para specs futuros):**

- Plantillas y puente de `user.registered`, `provider.rejected`, `payment.approved`, `payment.declined`, `order.confirmed` y `order.cancelled` (SPEC 10).
- Cambios de payload en `order` (`storeIds` en `order.confirmed`) y en `payments` (`buyerId`): los necesita el SPEC 10 para saber a quién avisar.
- Avisar a las tiendas (fan-out por `storeId`).
- Email, SMS o push reales.
- Endpoints de lectura de avisos y `/internal/*` con token de servicio.
- Reproceso manual de la DLQ y de eventos `FAILED` del puente.
- Limpieza (TTL) de `notification_outbox` y de `notifications`.
- Credenciales de RabbitMQ distintas por servicio y TLS.
- Despliegue de RabbitMQ en producción y clúster.

## Modelo de datos

### Contrato del mensaje (`libs/common/src/messaging/domain-event.schema.ts`)

```ts
// Sobre que viaja por RabbitMQ (el `DomainEvent` de las reglas)
type WireEvent = {
  eventId: string;       // uuid v4; estable ante reenvíos
  type: string;          // routing key, p. ej. 'provider.approved'
  occurredAt: string;    // ISO 8601
  correlationId: string; // id del pedido o, en eventos de auth, el userId
  payload: Record<string, unknown>;
};
```

El schema es `z.strictObject` con `eventId: z.uuid()`, `type` no vacío y `payload` como objeto. El mensaje se publica persistente (`persistent: true`) como JSON UTF-8, con `messageId = eventId`, `type` y `contentType: 'application/json'`. El `correlationId` también viaja como propiedad AMQP `correlationId`.

### Topología (`libs/common/src/messaging/topology.ts`)

| Elemento | Nombre | Notas |
| --- | --- | --- |
| Exchange | `mini-croper.events` | `topic`, durable. Routing key = `type` del evento |
| Cola | `notifications.events` | `quorum`, durable; `x-delivery-limit: 2`; `x-dead-letter-exchange: mini-croper.events.dlx` |
| Dead-letter exchange | `mini-croper.events.dlx` | `fanout`, durable |
| DLQ | `notifications.events.dlq` | `quorum`, durable, enlazada al DLX |

La cola se enlaza con las routing keys de `NOTIFIABLE_EVENTS`, constante de `topology.ts` que en este spec contiene solo `provider.approved`; el SPEC 10 añade las demás. `declareTopology(channel)` es idempotente y la llaman los dos lados al conectar, para que ninguno dependa de arrancar primero.

`x-delivery-limit: 2` significa una entrega inicial y dos reentregas, es decir, 3 intentos antes de pasar a la DLQ. El valor se verifica en el e2e (paso 12): si el broker cuenta distinto, se ajusta ahí.

### Colecciones de `api` (base `mini-croper`, módulo `notification-bridge`)

```ts
// schemas/notification-outbox.schema.ts → colección `notification_outbox`
// Clase `NotificationOutboxEvent`: Mongoose registra los modelos por nombre en la misma
// conexión y `order` ya tiene `OutboxEvent`.
type NotificationOutboxEvent = {
  _id: ObjectId;
  eventId: string;       // uuid v4; índice único
  type: string;
  correlationId: string;
  payload: Record<string, unknown>; // ya filtrado por la lista blanca
  occurredAt: Date;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  attempts: number;      // default 0
  nextAttemptAt: Date;   // default ahora
  lockedUntil?: Date;    // reclamo del job
  publishedAt?: Date;
  lastError?: string;    // sin payload
};
```

| Colección | Índice |
| --- | --- |
| `notification_outbox` | `{ eventId: 1 }` único; `{ status: 1, nextAttemptAt: 1 }` |

### Colecciones de `notifications` (base `mini-croper-notifications`)

```ts
// schemas/notification.schema.ts → colección `notifications`
type Notification = {
  _id: ObjectId;
  eventId: string;                       // evento de origen
  eventType: string;
  correlationId: string;
  destinatarioTipo: 'USER' | 'STORE';
  destinatarioId: ObjectId;              // userId o storeId
  plantilla: 'PROVIDER_APPROVED';        // el SPEC 10 amplía la lista
  titulo: string;
  mensaje: string;
  canal: 'SIMULATED';
  sentAt: Date;
  createdAt: Date;
};
```

| Colección | Índice |
| --- | --- |
| `notifications` | `{ eventId: 1, destinatarioTipo: 1, destinatarioId: 1 }` único; `{ destinatarioTipo: 1, destinatarioId: 1, createdAt: -1 }` |

La idempotencia del consumidor es el propio índice único: un evento repetido produce el mismo documento y el error 11000 se trata como "ya procesado". No hay colección `processed_events` aparte porque el aviso es el único efecto.

Los campos de referencia se declaran con `@Prop({ type: MongooseSchema.Types.ObjectId })` (regla de `CLAUDE.md`).

### Lista blanca de campos (`policies/event-sanitizer.policy.ts`)

Función pura `sanitizeForTransport(type, payload)` con una lista de campos permitidos por tipo. Un tipo sin entrada se rechaza (no se publica).

| Tipo | Campos que salen | Campos que se descartan |
| --- | --- | --- |
| `provider.approved` | `userId`, `reviewedBy` | `email` y cualquier otro |

### Variable de entorno nueva

Se suma a `envSchema` en `libs/common/src/config/env.schema.ts` (la heredan `apiEnvSchema` y `notifications`):

```ts
RABBITMQ_URI: z.string().regex(/^amqps?:\/\//),
```

| Variable | Obligatoria | Nota |
| --- | --- | --- |
| `RABBITMQ_URI` | Sí, en `api` y en `notifications` | `amqp://usuario:clave@host:5672`. Sin ella ninguna de las dos apps arranca y el error nombra la variable |

`.env.example` la incluye con las credenciales de desarrollo del `docker-compose.yml` (`amqp://mini-croper:mini-croper-dev@localhost:5672`), claramente de ejemplo.

### `docker-compose.yml`

Servicio `rabbitmq`: imagen `rabbitmq:4-management`, `hostname: mini-croper-rabbit` (RabbitMQ liga sus datos al hostname), puertos `5672` y `15672` (consola), volumen `rabbit-data`, `RABBITMQ_DEFAULT_USER=mini-croper`, `RABBITMQ_DEFAULT_PASS=mini-croper-dev` y `healthcheck` con `rabbitmq-diagnostics -q ping`. `docker compose up -d --wait` levanta ahora MongoDB y RabbitMQ.

## Puente en el monolito (`apps/api/src/modules/notification-bridge/`)

### Listener (`services/bridge-listener.service.ts`)

`@OnEvent(AuthEvents.ProviderApproved)` recibe el `ProviderApprovedEvent` en memoria (sin sobre ni `eventId`, como lo emite `auth`). Construye el sobre con `eventId` uuid v4 nuevo, `occurredAt` ahora y `correlationId = userId`, filtra el payload con la lista blanca e inserta en `notification_outbox` en `PENDING`. Importa `AuthEvents` y el tipo solo desde `modules/auth/index.js`.

- Un error 11000 sobre `eventId` se ignora: es un reenvío.
- Cualquier otro error del insert se registra con `error` (sin payload) y se relanza.
- Los eventos de `auth` se emiten con `emit` (sin esperar listeners): si el insert falla, el aviso se pierde. Es un riesgo aceptado (ver Riesgos). Los eventos de `order` y `payments` que sume el SPEC 10 sí se reintentan desde su origen, porque se emiten con `emitAsync`.

### Publicador (`services/bridge-publisher.service.ts`)

Mismo patrón que `OutboxPublisherService` de `order` (spec 07), con su propia política de backoff (`policies/publish-backoff.policy.ts`; no se importa archivo interno de `order`):

- `@Interval(2000)`. Si `EVENT_PUBLISHER.isConnected()` es falso, el ciclo se salta con un `warn` y **no** consume intentos: una caída del broker no agota los 5 intentos de los eventos.
- Reclama un evento a la vez con `findOneAndUpdate` atómico (`status: 'PENDING'`, `nextAttemptAt ≤ ahora`, `lockedUntil` ausente o vencido; fija `lockedUntil = ahora + 30 s`; orden `occurredAt` ascendente).
- Publica con `EVENT_PUBLISHER.publish(event)` y espera la confirmación del broker.
- Éxito: `status = 'PUBLISHED'`, `publishedAt = ahora`.
- Fallo con el broker conectado: `attempts += 1`, `lastError` con el mensaje, `lockedUntil` se limpia y `nextAttemptAt = ahora + min(2 s × 2^attempts, 60 s)`. Al quinto fallo pasa a `FAILED`.
- Un ciclo no se solapa con el anterior (bandera en memoria; una sola instancia).

### Publicador de RabbitMQ (`services/event-publisher.ts` y `services/rabbitmq-event-publisher.service.ts`)

```ts
interface EventPublisher {
  isConnected(): boolean;
  publish(event: WireEvent): Promise<void>; // resuelve al confirmar el broker
}
```

Se inyecta con el token `EVENT_PUBLISHER` (`{ provide: EVENT_PUBLISHER, useClass: RabbitMqEventPublisher }`), así que cambiar el transporte solo cambia el provider. La implementación usa la conexión de `libs/common`, publica en el exchange `mini-croper.events` con la routing key igual al `type` y `persistent: true`, y espera la confirmación (`waitForConfirms`).

## Consumidor en `notifications`

### Conexión y consumo (`consumers/events.consumer.ts`)

En `onApplicationBootstrap` conecta, llama a `declareTopology`, fija `prefetch(10)` y consume `notifications.events` con `noAck: false`. Por cada mensaje:

1. Parsea el JSON y valida el sobre con `domainEventSchema`. Si el JSON o el sobre son inválidos, `nack(msg, false, false)`: va directo a la DLQ, porque reintentar no lo arregla.
2. Busca la plantilla por `type` en el registro de `templates/`. Si no existe, `ack` y un `warn` con el `type` (evento enlazado sin plantilla; no debería ocurrir con la lista actual).
3. Llama a `NotificationsService.handle(event)`. Éxito o 11000: `ack`.
4. Cualquier otra excepción: `nack(msg, false, true)` mientras la entrega sea la 1.ª o la 2.ª, y `nack(msg, false, false)` en la 3.ª (el DLX la manda a la DLQ). El consumidor cuenta las entregas con la cabecera `x-acquired-count` de la cola quorum (ausente en la 1.ª; entregas = valor + 1). Se registra un `error` con `eventId` y `type`, nunca con el payload.

> **Corrección del paso 12 (2026-11-08):** con RabbitMQ 4.4, `x-delivery-limit` **no cuenta** los `nack` con requeue (AMQP 0.9.1): el mensaje se reentregó más de 600 veces sin llegar a la DLQ. El tope de 3 intentos lo aplica el consumidor; `x-delivery-limit` queda en la cola como respaldo.

Si la conexión se cae, el envoltorio reconecta (espera de 5 s entre intentos) y el consumidor vuelve a suscribirse.

### Servicio y plantillas

- `services/notifications.service.ts` (el existente se mueve con `git mv` y se reescribe): `handle(event)` obtiene de la plantilla el borrador de aviso, inserta el `Notification` con `canal: 'SIMULATED'` y `sentAt` ahora, y deja un log `log` con `plantilla`, `destinatarioTipo` y `destinatarioId` (nunca el mensaje completo).
- `templates/notification-templates.ts`: registro `{ [type]: (event) => NotificationDraft[] }` y el tipo `NotificationDraft`. Una plantilla devuelve una lista, aunque aquí sea de uno, porque el SPEC 10 avisa a varios destinatarios.
- `templates/provider-approved.template.ts` (función pura):

| Campo | Valor |
| --- | --- |
| `destinatarioTipo` / `destinatarioId` | `USER` / `payload.userId` |
| `plantilla` | `PROVIDER_APPROVED` |
| `titulo` | `Solicitud aprobada` |
| `mensaje` | `Tu solicitud como proveedor fue aprobada. Ya puedes iniciar sesión y crear tu tienda.` |

El `userId` de un payload mal formado (no es un ObjectId de 24 hex) lanza una excepción de validación, que el consumidor trata como el caso 4. Los mensajes no incluyen email ni datos personales.

### Envoltorio de mensajería (`libs/common/src/messaging/`)

- `topology.ts`: constantes de nombres, `NOTIFIABLE_EVENTS` y `declareTopology(channel)`.
- `domain-event.schema.ts`: `domainEventSchema` y el tipo `WireEvent`.
- `rabbitmq-connection.ts`: clase `RabbitMqConnection` que abre la conexión con `amqplib`, expone un canal con confirmaciones, `isConnected()` y reconecta a los 5 s si la conexión se cierra. Es lo único que importa `amqplib`.

## Estructura de archivos

```text
libs/common/src/messaging/
  topology.ts
  domain-event.schema.ts
  rabbitmq-connection.ts
  (specs colocados junto a cada archivo)
apps/api/src/modules/notification-bridge/
  index.ts                            # exporta NotificationBridgeModule
  notification-bridge.module.ts
  services/
    bridge-listener.service.ts
    bridge-publisher.service.ts
    event-publisher.ts                # interfaz EventPublisher y token EVENT_PUBLISHER
    rabbitmq-event-publisher.service.ts
  schemas/
    notification-outbox.schema.ts
  policies/
    event-sanitizer.policy.ts
    publish-backoff.policy.ts
  tests/                              # todos los *.spec.ts, planos
apps/notifications/src/
  main.ts
  notifications.module.ts
  consumers/
    events.consumer.ts
  services/
    notifications.service.ts          # git mv desde src/notifications.service.ts
  schemas/
    notification.schema.ts
  templates/
    notification-templates.ts
    provider-approved.template.ts
  (specs colocados junto a cada archivo)
apps/notifications/test/
  events.e2e-spec.ts
apps/api/test/
  notification-bridge.e2e-spec.ts
```

`notifications.controller.ts` y `notifications.controller.spec.ts` se eliminan; `apps/notifications/test/app.e2e-spec.ts` se reescribe para cubrir `GET /health`. `NotificationBridgeModule` se registra en `ApiModule`. Cada carpeta se crea solo cuando tiene contenido; no hace falta ninguna carpeta fuera de la lista de `CLAUDE.md`.

## Plan de implementación

Cada paso deja el sistema compilando y con `npm test` en verde, es commiteable por separado y no supera 30–50 líneas de código de producción (sin contar specs).

1. **Contrato y topología.** Añadir la dependencia `amqplib` (y `@types/amqplib`), crear `libs/common/src/messaging/domain-event.schema.ts` y `topology.ts` (nombres, `NOTIFIABLE_EVENTS`, `declareTopology` con un canal simulado). Specs: el sobre acepta un evento válido y rechaza propiedades de más, `eventId` no uuid y `payload` no objeto; `declareTopology` declara el exchange, la cola con sus argumentos, el DLX, la DLQ y un enlace por cada evento de la lista.
2. **Variable de entorno.** Añadir `RABBITMQ_URI` a `envSchema`, a `.env.example` y a los entornos de los specs y e2e existentes que llaman a `validateEnv` o `validateApiEnv`. Specs: falta, esquema distinto de `amqp(s)://` y válida (patrón de `env.schema.spec.ts`).
3. **RabbitMQ en docker-compose.** Añadir el servicio `rabbitmq`, su volumen y el `healthcheck`. Verificación manual: `docker compose up -d --wait` deja ambos servicios `healthy` y la consola responde en el puerto 15672.
4. **Conexión.** Crear `libs/common/src/messaging/rabbitmq-connection.ts`: conexión, canal con confirmaciones, `isConnected()` y reconexión a los 5 s. Specs con `amqplib` simulado y temporizadores falsos: conecta, reconecta tras `close`, `isConnected()` refleja el estado.
5. **Lista blanca y backoff.** Crear `policies/event-sanitizer.policy.ts` y `policies/publish-backoff.policy.ts` en `notification-bridge`. Specs: `provider.approved` descarta `email` y campos desconocidos, un tipo sin entrada se rechaza, backoff 4 s, 8 s… con tope de 60 s.
6. **Outbox del puente.** Crear `schemas/notification-outbox.schema.ts` con sus índices y registrarlo con `MongooseModule.forFeature` en `NotificationBridgeModule` (módulo vacío por ahora, registrado en `ApiModule`). Spec de defaults e índices (patrón de `auth/tests/schemas.spec.ts`).
7. **Listener.** Crear `services/bridge-listener.service.ts` con `@OnEvent('provider.approved')`: sobre con `eventId` nuevo, lista blanca e insert. Specs: guarda el sobre sin `email`, `correlationId = userId`, 11000 se ignora, otro error se relanza.
8. **Publicador de RabbitMQ.** Crear `event-publisher.ts` y `rabbitmq-event-publisher.service.ts` y registrar `{ provide: EVENT_PUBLISHER, useClass: ... }`. Specs con la conexión simulada: publica en el exchange con la routing key del `type`, `persistent`, `messageId = eventId`, y espera la confirmación; un `nack` del broker rechaza la promesa.
9. **Job de publicación.** Crear `services/bridge-publisher.service.ts` con `@Interval(2000)`: reclamo atómico, éxito, fallo con backoff, `FAILED` al quinto, salto del ciclo sin broker sin consumir intentos. Specs con el publicador simulado: éxito, fallo reintenta, quinto fallo `FAILED`, evento bloqueado no se reclama, desconectado no cambia `attempts`.
10. **Schema y servicio de `notifications`.** Crear `schemas/notification.schema.ts` con sus índices, `templates/notification-templates.ts`, `templates/provider-approved.template.ts` y reescribir `services/notifications.service.ts` (`handle`). Eliminar `NotificationsController` y su spec. Specs: la plantilla produce el borrador esperado, `handle` inserta el aviso y deja el log sin `mensaje`, un evento repetido (11000) no duplica, `userId` inválido lanza.
11. **Consumidor.** Crear `consumers/events.consumer.ts` y cablearlo en `NotificationsModule`: consumo con `noAck: false`, `ack` en éxito y 11000, `nack` con requeue ante excepción, `nack` sin requeue ante mensaje inválido, evento sin plantilla `ack` con `warn`. Specs con canal simulado: cada rama.
12. **E2E de `notifications`.** Crear `apps/notifications/test/events.e2e-spec.ts` contra MongoDB y RabbitMQ reales: un `provider.approved` publicado en el exchange deja un `Notification`; el mismo `eventId` dos veces deja uno; un JSON inválido llega a la DLQ sin reintentos; un manejador forzado a fallar siempre deja el mensaje en la DLQ tras exactamente 3 entregas (calibra `x-delivery-limit`). Reescribir `app.e2e-spec.ts` para `GET /health`.
13. **E2E del puente.** Crear `apps/api/test/notification-bridge.e2e-spec.ts` contra MongoDB y RabbitMQ reales, con una cola exclusiva de prueba enlazada al exchange: aprobar a un PROVEEDOR por la API deja un mensaje `provider.approved` sin `email` y un `notification_outbox` en `PUBLISHED`; con el broker caído el evento sigue `PENDING` y sin intentos consumidos, y se publica al volver.
14. **Verificación de punta a punta.** Levantar `api` y `notifications` a la vez, aprobar a un PROVEEDOR con un `ADMIN` y comprobar que `notifications` tiene el documento y que `notification_outbox` está `PUBLISHED`. Los comandos quedan en `CLAUDE.md` (paso 15).
15. **Documentación.** Actualizar `docs/reglas-de-negocio.md` (transporte RabbitMQ, DLQ implementada, eventos sin datos personales, entidad `Notification`, fecha e historial) y `CLAUDE.md` (transporte, módulo `notification-bridge`, variable `RABBITMQ_URI` en la tabla de entorno de ambas apps, `docker compose up` con RabbitMQ).

## Criterios de aceptación

- [ ] `docker compose up -d --wait` deja `mongo` y `rabbitmq` en estado `healthy` y la consola de RabbitMQ responde en el puerto 15672.
- [ ] `RABBITMQ_URI` ausente o con un esquema distinto de `amqp://`/`amqps://` impide arrancar `api` y `notifications`, y el error nombra la variable.
- [ ] `declareTopology` es idempotente: llamarla dos veces, desde cada app, no falla ni cambia nada.
- [ ] La cola `notifications.events` es `quorum`, durable, con `x-delivery-limit` y `x-dead-letter-exchange` hacia `mini-croper.events.dlx`; `notifications.events.dlq` recibe lo dead-lettered.
- [ ] Aprobar a un PROVEEDOR (`provider.approved`) deja un documento en `notification_outbox` con `eventId` uuid, `correlationId = userId` y `payload` igual a `{ userId, reviewedBy }`.
- [ ] Ningún mensaje publicado en RabbitMQ ni documento de `notification_outbox` o `notifications` contiene el `email` del usuario.
- [ ] Un tipo de evento sin entrada en la lista blanca no se publica.
- [ ] El job del puente corre cada 2 s, publica con confirmación del broker, marca `PUBLISHED` y guarda `publishedAt`.
- [ ] Un fallo de publicación con el broker conectado suma `attempts`, guarda `lastError`, aplica backoff y, al quinto fallo, deja el evento en `FAILED` sin más reintentos.
- [ ] Con el broker caído el job no consume intentos y el evento se publica al volver la conexión.
- [ ] Un evento reclamado con `lockedUntil` vigente no lo publica un segundo ciclo.
- [ ] Reenviar el mismo `eventId` al puente no crea otro documento de `notification_outbox`.
- [ ] `notifications` guarda un `Notification` por `provider.approved` con `destinatarioTipo: USER`, `plantilla: PROVIDER_APPROVED`, `canal: SIMULATED` y `sentAt`.
- [ ] El mismo `eventId` entregado dos veces a `notifications` deja un solo `Notification`.
- [ ] Un mensaje con JSON o sobre inválido llega a la DLQ sin reintentos.
- [ ] Un mensaje cuyo procesamiento falla siempre llega a la DLQ tras exactamente 3 entregas.
- [ ] Un mensaje se confirma (`ack`) solo después de guardar el aviso; si `notifications` cae a mitad, el mensaje se reentrega al volver.
- [ ] El consumidor y el puente se reconectan solos tras perder la conexión con RabbitMQ.
- [ ] Ningún log del puente ni del consumidor contiene el payload, el mensaje del aviso, un email ni el contenido de `RABBITMQ_URI`.
- [ ] `notification-bridge` importa de `auth` solo desde `modules/auth/index.js`, y ningún otro módulo importa archivos internos de `notification-bridge`.
- [ ] `notification-bridge` y `notifications` no se escriben las colecciones entre sí; cada app solo toca su base.
- [ ] `NotificationsController` y `getHello` ya no existen y `GET /health` de `notifications` responde 200.
- [ ] `notification-bridge` cumple la estructura de módulo de `CLAUDE.md`: en la raíz solo `index.ts` y `notification-bridge.module.ts`; carpetas de la lista estándar y sin vacías; todos los `*.spec.ts` planos en `tests/`.
- [ ] Con `api` y `notifications` corriendo, aprobar a un PROVEEDOR deja un `Notification` en `mini-croper-notifications` y el evento `PUBLISHED` en `notification_outbox`.
- [ ] El spec no añade plantillas, listeners ni cambios de payload de ningún otro evento.
- [ ] `docs/reglas-de-negocio.md` documenta las reglas nuevas y tiene entrada nueva en el historial; `CLAUDE.md` refleja el transporte, el módulo y la variable.
- [ ] `npm run build:all`, `npm run lint`, `npm test` y `npm run test:e2e` terminan sin errores.

## Decisiones

- **Sí:** RabbitMQ como transporte. Es lo que describen las reglas (ack manual y DLQ) y es el único camino que cumple la DLQ tal como está escrita.
- **No:** HTTP interno con token de servicio. Sin infraestructura nueva, pero la DLQ y el ack habría que simularlos en Mongo.
- **No:** cola en MongoDB. Acopla las dos bases y `notifications` dejaría de ser independiente.
- **Sí:** `amqplib` directo con un envoltorio en `libs/common`. El contrato del mensaje es el sobre `DomainEvent`, no el `{ pattern, data }` de `@nestjs/microservices`.
- **No:** `@nestjs/microservices` (transporte RMQ). Obliga a adaptar el formato del mensaje y oculta el control de ack y de confirmaciones.
- **Sí:** exchange `topic` con la routing key igual al `type`, y una cola enlazada por tipo. Permite que otro consumidor se enlace sin cambiar el publicador.
- **Sí:** cola `quorum` con DLX; el consumidor cuenta las entregas con `x-acquired-count` y hace `nack` sin requeue en la 3.ª. (Se pensó que el broker la contaba con `x-delivery-limit`, pero no cuenta los `nack` con requeue en RabbitMQ 4.x; se descartó el contador propio en Mongo.)
- **Sí:** `nack` sin requeue para mensajes inválidos. Reintentar un JSON roto solo retrasa la DLQ.
- **Sí:** puente en el monolito con `notification_outbox` propio. Entrega al menos una vez sin tocar el outbox de `order` (spec 07) ni cambiar cómo emiten `auth` y `payments`.
- **No:** puente directo sin outbox. Un broker caído en ese instante perdería el aviso.
- **No:** que cada módulo publique a RabbitMQ. Rompe el desacople de eventos en memoria y duplica la lógica.
- **Sí:** `eventId` único en `notification_outbox`. Es la idempotencia del reenvío de `order` y `payments` y no cuesta una colección extra.
- **Sí:** los eventos de `auth` reciben `eventId` en el puente (no lo traen). Lo único que cambia es la identidad del evento al salir.
- **Sí:** lista blanca de campos por tipo, y rechazo de tipos sin entrada. Un campo nuevo en un evento de dominio no se filtra a RabbitMQ por descuido, a diferencia de una lista negra.
- **No:** quitar `email` en `auth`. Cambiaría el spec 03 (aprobado) y sus tests, y `auth` lo usa en memoria.
- **No:** reenviar el `email`. Quedaría en el broker, en sus logs y en la base de `notifications`, contra el mínimo de datos de Habeas Data.
- **Sí:** aviso con destinatario por `userId` o `storeId`, guardado en Mongo con `canal: SIMULATED` y log. Deja historial verificable en e2e sin email real ni PII.
- **No:** solo log. No se puede verificar sin leer logs ni deja historial.
- **Sí:** el índice único `{ eventId, destinatarioTipo, destinatarioId }` es la idempotencia del consumidor, sin colección `processed_events`. El aviso es el único efecto, así que marcar y aplicar son el mismo insert.
- **Sí:** el ciclo del puente se salta sin consumir intentos cuando no hay conexión. Una caída del broker de más de un minuto no debe llevar eventos a `FAILED`.
- **Sí:** duplicar la política de backoff dentro de `notification-bridge`. Importarla de `order` rompería la frontera de módulos y moverla cambiaría un spec implementado.
- **Sí:** `EVENT_PUBLISHER` como token con interfaz. Mismo patrón que `PAYMENT_GATEWAY` del spec 08; cambiar de broker es cambiar un provider.
- **Sí:** `RABBITMQ_URI` obligatoria en las dos apps, porque ambas se conectan al arrancar.
- **Sí:** el trabajo se divide en dos specs. Este deja la infraestructura verificable con un evento real; los otros seis eventos y los cambios de payload van en el SPEC 10.
- **Sí:** `provider.approved` como evento de prueba. Es el único con payload completo y sin necesidad de cambios en otros módulos.
- **No:** endpoints de lectura de avisos. Exigirían `/internal/*` con token de servicio, otra decisión de seguridad que merece su spec; los e2e leen Mongo.
- **Sí:** `docs/reglas-de-negocio.md` y `CLAUDE.md` se actualizan al implementar (paso 15), no al escribir este spec.

## Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Los eventos de `auth` se emiten con `emit` y no se reintentan: si el insert en `notification_outbox` falla, el aviso se pierde | Aceptado: un aviso perdido no rompe ningún flujo de negocio. Se registra un `error` sin payload. Si importa más adelante, `auth` pasa a `emitAsync` en otro spec. |
| El puente guarda `payload` aunque ya filtrado: un cambio futuro de la lista blanca puede abrirla por error | La lista blanca es una tabla con spec que fija los campos de cada tipo; un tipo sin entrada se rechaza. |
| `x-delivery-limit` no cuenta los `nack` con requeue en RabbitMQ 4.x (hallazgo del paso 12) | El consumidor cuenta las entregas con `x-acquired-count` y manda a la DLQ en la 3.ª; el e2e comprueba exactamente 3 entregas. Depende de que la cola quorum siga exponiendo esa cabecera. |
| Reentrega inmediata: los 3 intentos ocurren casi sin espera, así que un fallo transitorio de Mongo puede agotarlos | Aceptado en este spec. Un reintento con espera (cola de retardo) queda para un spec posterior si hace falta. |
| Un mensaje en la DLQ queda sin reproceso manual | Visible en la consola de RabbitMQ (puerto 15672). El reproceso queda fuera de alcance. |
| Caída del consumidor con mensajes sin `ack` | Quorum queue y `noAck: false`: el broker reentrega al reconectar. El aviso es idempotente por su índice único. |
| `amqplib` no reconecta solo | `RabbitMqConnection` reconecta a los 5 s y los dos lados vuelven a declarar la topología; cubierto con specs de temporizadores falsos. |
| Cualquiera con `RABBITMQ_URI` puede publicar un evento falso (las reglas dicen que `notifications` solo acepta eventos del monolito) | Aceptado en este spec: una sola credencial de desarrollo. Credenciales por servicio y permisos de publicación quedan para el despliegue. |
| `api` y todos sus e2e dependen de `RABBITMQ_URI` y de RabbitMQ arriba | `docker compose up -d --wait` lo levanta junto a MongoDB. Con el broker caído `api` arranca igual: el puente guarda y espera. |
| `GET /health` de `notifications` no refleja si el consumidor está conectado | Aceptado: `HealthModule` es compartido y solo mira MongoDB. El estado del consumidor se ve en la consola de RabbitMQ. |
| Los jobs corren en una sola instancia (bandera en memoria) | Heredado de `CLAUDE.md`; el reclamo atómico con `lockedUntil` ya cubre dos instancias. |
| Las transacciones y el reclamo atómico exigen MongoDB en replica set | `docker-compose.yml` ya lo levanta como `rs0`. |
| ESM: imports relativos sin `.js` rompen el build | Seguir la convención del repo (`./archivo.js`). |

## Qué **no** está en este spec

- Plantillas, listeners y puente de `user.registered`, `provider.rejected`, `payment.*` y `order.*` (SPEC 10).
- Cambios de payload en `order` y `payments`, y el aviso a cada tienda.
- Email, SMS o push reales.
- Endpoints de lectura de avisos y `/internal/*`.
- Reproceso de la DLQ y de eventos `FAILED`, y limpieza (TTL) de colecciones.
- Credenciales por servicio, TLS y despliegue de RabbitMQ en producción.

Cada uno de estos, si se aborda, va en su propio spec.
