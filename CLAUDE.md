# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

App NestJS 12 (`agro-app-workspace`) como monorepo de Nest CLI con **arquitectura híbrida**: un monolito modular (`apps/api`) y un único servicio aparte (`apps/notifications`). Ver "Arquitectura" abajo y `AGENTS.md` para el índice de paquetes de primera parte de NestJS y las notas de telemetría NestJS Observe; NestJS 12 es más nuevo que la mayoría de los datos de entrenamiento, así que consulta https://docs.nestjs.com/llms.txt cuando tengas dudas.

## Reglas de negocio

Las reglas de negocio de Mini-Croper (marketplace agropecuario multi-vendedor con pago virtual simulado) están en `docs/reglas-de-negocio.md`. Léelo antes de implementar cualquier dominio (auth, catálogo, pedidos, pagos, notificaciones).

- `docs/reglas-de-negocio.md` es un **documento vivo**: si una regla cambia, actualízalo en el mismo cambio que toca el código y anota el cambio en su "Historial de cambios".
- `specs/01-reglas-de-negocio.md` es la foto inicial de esas reglas; ya no se mantiene.
- `references/LogicaNegocio.md` es la fuente de origen y **no es definitivo**; se conserva sin modificar.
- Ante conflicto de **reglas de negocio**, manda `docs/reglas-de-negocio.md`.
- Ante conflicto de **stack** (NestJS, Jest/Vitest, `class-validator`, etc.), mandan las convenciones de este archivo, no las del markdown fuente.
- La arquitectura vigente es **híbrida** (ver "Arquitectura"). El diseño original de `references/LogicaNegocio.md` y de `specs/01-reglas-de-negocio.md` (gateway + 5 servicios + RabbitMQ) **ya no aplica**; las reglas de negocio sí.

## Arquitectura

Decisión: **monolito modular + notifications separado**. Ya no son 6 servicios (gateway + auth + catalog + order + payments + notifications).

| App | Ruta | Puerto | Contenido |
| --- | --- | --- | --- |
| `api` (monolito) | `apps/api` | 3000 | Módulos `auth`, `catalog`, `order`, `payments` en `src/modules/<dominio>/`, compuestos en `ApiModule`. Es la única entrada pública; no hay API Gateway. |
| `notifications` | `apps/notifications` | 3005 | Único servicio independiente: consume eventos y envía avisos simulados. |

- Rutas HTTP del monolito: un prefijo por módulo (`/auth`, `/catalog`, `/orders`, `/payments`).
- Los módulos del monolito se hablan por inyección de dependencias o eventos en memoria, nunca por HTTP. Cada módulo exporta solo su API pública y no importa archivos internos de otro módulo, para poder extraerlo después si hace falta.
- A `notifications` le llegan los eventos de dominio (`payment.approved`, `order.confirmed`, etc.). El transporte (RabbitMQ u otro) **aún no está implementado ni decidido**.
- `libs/common` guarda código compartido (p. ej. `setupSwagger`, los schemas de entorno `validateEnv` y `validateApiEnv`, el `HealthModule` con `GET /health` y la seguridad transversal en `security/`).

### Persistencia (MongoDB)

- Base de datos: **MongoDB** con `@nestjs/mongoose` (Mongoose). Una base por app con `dbName` fijo en el código: `api` usa `mini-croper` y `notifications` usa `mini-croper-notifications`.
- Ambas apps leen la misma variable `MONGODB_URI`, validada con Zod (`libs/common/src/config/env.schema.ts`) al arrancar: si falta, la app no inicia. `api` valida con `validateApiEnv` (suma las variables de seguridad de abajo) y `notifications` con `validateEnv`, así que no le exige claves JWT.
- MongoDB debe correr como **replica set** (`rs0`, un nodo): las transacciones (reserva de stock, outbox) lo exigen. `docker-compose.yml` ya lo levanta así.
- Cada módulo es dueño de sus colecciones; los schemas de dominio viven en el módulo, no en `libs/common`.
- Los campos de referencia a otro documento se declaran con `@Prop({ type: MongooseSchema.Types.ObjectId })` (`import { Schema as MongooseSchema } from 'mongoose'`). Con `type: Types.ObjectId` Mongoose los trata como `Mixed` y guarda strings.

### Estructura de un módulo

Todo módulo de `apps/api/src/modules/<dominio>/` tiene la misma forma: carpetas por tipo de archivo y un `index.ts` como API pública.

```text
apps/api/src/modules/<dominio>/
  index.ts                  # API pública del módulo (lo único importable desde fuera)
  <dominio>.module.ts
  controllers/              # *.controller.ts
  services/                 # *.service.ts
  dto/                      # schemas Zod de entrada (*.dto.ts)
  schemas/                  # schemas Mongoose (*.schema.ts)
  events/                   # nombres y payloads de eventos (*.events.ts)
  policies/                 # reglas puras sin Nest (p. ej. password.policy.ts)
  tests/                    # TODOS los *.spec.ts del módulo, planos
```

- En la raíz del módulo solo van `index.ts` y `<dominio>.module.ts`. Cada tipo de archivo va en su carpeta (un controller en `controllers/`, un service en `services/`, etc.); los nombres de archivo no cambian.
- Las carpetas se crean **solo cuando tienen contenido**: nunca carpetas vacías ni `.gitkeep`. Una carpeta fuera de la lista (p. ej. `guards/`) solo se añade si el módulo la necesita de verdad, y se agrega a esta lista en el mismo cambio.
- `tests/` es la **única carpeta de pruebas unitarias** del módulo: todos los `*.spec.ts` van ahí, sin subcarpetas, con el nombre del archivo que prueban más `.spec.ts`. Los tests importan por ruta relativa al archivo interno (`../services/auth.service.js`), no por el `index.ts`. Los e2e siguen en `apps/<app>/test/`.
- `index.ts` es la API pública: lo único que otros módulos y `ApiModule` pueden importar (`modules/<dominio>/index.js`). Nunca se importa un archivo interno de otro módulo. Dentro del módulo se importa por ruta relativa al archivo concreto, con `.js`.
- Hoy `auth` exporta `AuthModule`, `AuthEvents` y los tipos de sus eventos. `catalog` exporta `CatalogModule`, `CatalogQueryService` (con `getCheckoutVariants`, que usará `order` para tomar el precio del catálogo), `CatalogEvents`, `ConsumedOrderEvents`, el tipo `DomainEvent`, los tipos de sus payloads y `CheckoutVariant`. `order` exporta `OrderModule`, `OrderQueryService` (con `getOrderForPayment`, que usará `payments` para tomar el monto y el estado del pedido), `OrderEvents`, `ConsumedEvents`, el tipo `DomainEvent`, los tipos de sus payloads y `OrderForPayment`. `payments` exporta `PaymentsModule`, `PaymentEvents` y los tipos `PaymentApprovedPayload` y `PaymentDeclinedPayload` (reexportados de `order`).

### Seguridad (módulo `auth`)

Las reglas de negocio (estados del usuario, aprobación de PROVEEDOR, política de contraseña, bloqueo, límites) están en `docs/reglas-de-negocio.md`; aquí solo cómo se aplican en el código.

- **Todo endpoint es privado salvo `@Public()`.** `SecurityModule` (`libs/common/src/security/`) registra por `APP_GUARD`, en este orden, `ThrottlerGuard`, `JwtAuthGuard` y `RolesGuard`. Un endpoint nuevo nace privado; si olvidas el decorador, no queda abierto.
- `@Public()`, `@Roles(...)`, `@CurrentUser()` y el tipo `AuthenticatedUser` (`{ id, rol, sessionId, storeId? }`) viven en `libs/common/src/security/`. Los demás módulos los importan de ahí y **nunca de archivos internos de `auth`**. Las reglas de propiedad por recurso (PROVEEDOR solo su `storeId`, PRODUCTOR solo sus pedidos) las aplica cada dominio con `@CurrentUser()`.
- `JwtAuthGuard` verifica con la clave pública y fija `algorithms: ['RS256']`, `issuer` y `audience`; solo `auth` firma, con la clave privada. Los tokens no llevan email ni documento.
- `StandardSchemaValidationPipe` es global (`APP_PIPE`). Los DTO son `z.strictObject` y se pasan como `@Body({ schema })`, `@Param('id', { schema })` o `@Query({ schema })`: rechazan propiedades desconocidas y tipos inesperados (p. ej. `{"$ne": null}`).
- `applySecurity` (`libs/common/src/security/apply-security.ts`), llamado desde `main.ts`, activa `helmet`, CORS con lista blanca (`CORS_ORIGINS`; vacía = sin orígenes cruzados), quita `X-Powered-By` y limita el body a 100 kb. Con `NODE_ENV=production` `setupSwagger` no publica Swagger.
- `order` emite `order.created`, `order.confirmed` y `order.cancelled` **solo vía outbox**: `OutboxService.add(session, ...)` los guarda en `outbox_events` dentro de la transacción del cambio de estado y `OutboxPublisherService` (job cada 2 s) los publica con `EventEmitter2.emitAsync` y el sobre `DomainEvent`. Ningún otro servicio de `order` llama a `emit` para `order.*`. Escucha `stock.reserved`, `stock.rejected`, `stock.released`, `payment.approved` y `payment.declined` en `OrderSagaService`, con idempotencia en `order_processed_events` (el `catalog` usa `processed_events`: los nombres de clase de los schemas no pueden repetirse porque Mongoose registra los modelos por nombre en la misma conexión). `OrderExpirationService` (job cada 10 s) cancela los pedidos vencidos con actualizaciones condicionales.
- **Jobs con `@nestjs/schedule`:** `OrderModule` importa `ScheduleModule.forRoot()` y los jobs usan `@Interval`. Corren en una sola instancia (cada servicio lleva su bandera en memoria para no solaparse); con varias instancias harían falta locks distribuidos. El outbox ya reclama cada evento con un `findOneAndUpdate` atómico y `lockedUntil`, pero la expiración no.
- **Orden de los controllers de `order`:** en `OrderModule`, las rutas fijas (`cart`, `provider`, `admin`) se registran antes que `OrdersController` (`GET /orders/:id`); si no, `:id` las captura y devuelve 400.
- **Pagos (`payments`):** `POST /payments` es síncrono (el simulador tras el token `PAYMENT_GATEWAY` espera de 1 a 3 s) e idempotente: la `Idempotency-Key` y el hash del cuerpo viven en el propio `Payment`, y un índice único parcial sobre `orderId` deja un solo pago activo o aprobado por pedido. `POST /payments/webhook` es `@Public()` y se autentica por firma HMAC-SHA256 sobre `${timestamp}.${rawBody}`, por eso `main.ts` y los e2e crean la app con `rawBody: true`. `payments` emite `payment.approved` y `payment.declined` en memoria (sin outbox, que es de `order`) y `PaymentEventsService` reemite cada 10 s los pagos finales sin marca de emisión, hasta 5 veces. Los controllers llevan `@Throttle` de 10 por minuto, y `PaymentsAdminController` se registra antes que `PaymentsController` para que `admin` no caiga en `:id`.
- **Proxy:** no se activa `trust proxy`. Detrás de un proxy el throttler vería la IP del proxy y limitaría a todos juntos; decídelo con el despliegue. El throttler guarda sus contadores en memoria (una sola instancia).
- El access token no se revoca: tras `disable` o un cambio de rol sigue valiendo hasta 15 min. Para que no se pueda renovar, esas acciones revocan los refresh tokens.
- `auth` emite eventos en memoria con `@nestjs/event-emitter` (`user.registered`, `provider.approved`, `provider.rejected`; nombres en `events/auth.events.ts`). Todavía no tienen consumidor: los conectará el spec de notificaciones.
- `catalog` emite en memoria `store.created` (sin sobre, como los de `auth`) al crearse una tienda; `auth` lo escucha en `StoreAssignmentService` y guarda `User.storeId` (es el único punto donde `auth` importa de `catalog`, solo vía `modules/catalog/index.js`). `catalog` también escucha `order.created`, `order.confirmed` y `order.cancelled` y emite `stock.reserved`, `stock.rejected` y `stock.released` con el sobre `DomainEvent`, después del commit de su transacción.

#### Variables de entorno de `api`

| Variable | Obligatoria | Nota |
| --- | --- | --- |
| `JWT_PRIVATE_KEY` | Sí | PEM RSA de 2048 bits o más; admite `\n` escapados |
| `JWT_PUBLIC_KEY` | Sí | PEM correspondiente |
| `PAYMENTS_WEBHOOK_SECRET` | Sí | Secreto compartido del HMAC del webhook de pagos; mínimo 32 caracteres |
| `CORS_ORIGINS` | No | Lista separada por comas; vacía = sin CORS |
| `NODE_ENV` | No | `production` desactiva Swagger |

`ADMIN_EMAIL` y `ADMIN_PASSWORD` solo las lee `npm run seed:admin`; la app no.

## Commands

- **Primera vez:** copia `.env.example` a `.env` (ignorado por git), genera las claves JWT y levanta MongoDB con `docker compose up -d --wait`. Sin `MONGODB_URI` ninguna app arranca; sin `JWT_PRIVATE_KEY` o `JWT_PUBLIC_KEY` no arranca `api` (`notifications` sí) y el error nombra la variable. `docker compose down` lo detiene y conserva los datos en el volumen `mongo-data`.
- `npm run keys:generate` — imprime un par RSA 2048 como dos líneas `JWT_PRIVATE_KEY=` y `JWT_PUBLIC_KEY=` (saltos de línea como `\n`) para pegar en `.env`. No escribe nada en disco.
- `ADMIN_EMAIL=admin@correo.com ADMIN_PASSWORD='...' npm run seed:admin` — crea el primer ADMIN (el registro público nunca crea uno). Sin credenciales por defecto, aplica la misma política de contraseña que el registro y es idempotente: si el email ya es ADMIN no hace nada, y si es de otro rol falla sin tocarlo. Pasa las dos variables en el comando, no las dejes en `.env`. Node ejecuta `scripts/seed-admin.ts` directamente (sin transpilar), por eso solo importa archivos sin decoradores (`password.policy.ts`); `scripts/` queda fuera de lint y typecheck.
- `GET /health` (puertos 3000 y 3005) responde 200 si MongoDB contesta y 503 si no.
- `npm run start:dev` — run `api` (default project) with watch mode (`start`, `start:debug`, `start:prod` also exist; prod runs `node dist/apps/api/main`). Listens on `PORT` or 3000. `npm run start:dev:notifications` / `npm run start:prod:notifications` run the notifications service (port 3005; prod runs `node dist/apps/notifications/main`).
- `npm run build` — `nest build` of `api` only (cleans `dist/`). `npm run build:all` builds `api` and `notifications`.
- `npm run lint` — `oxlint --type-aware apps/ libs/` (oxlint, not ESLint; `no-floating-promises` is an error).
- `npm run format` — Prettier (single quotes, trailing commas).
- `npm test` — Vitest unit tests (`**/*.spec.ts`; in `apps/api` they live in each module's `tests/` folder, see "Estructura de un módulo"; elsewhere they are colocated next to the code).
- Single test: `npx vitest run apps/api/src/modules/auth/auth.controller.spec.ts` or `npx vitest run -t "test name"`.
- `npm run test:e2e` — e2e tests (`**/*.e2e-spec.ts`, in `apps/<app>/test/`) via `vitest.config.e2e.ts`. Los de `api` necesitan `MONGODB_URI` y MongoDB en replica set; generan sus propias claves JWT y crean usuarios `e2e-*@test.co` en la base `mini-croper`, que borran al terminar (si la suite se corta, pueden quedar).

## Conventions that differ from typical Nest projects

- **ESM-only** (`"type": "module"`, `module: nodenext`): relative imports must end in `.js` (e.g. `./app.module.js`), `__dirname` is unavailable (use `import.meta.dirname`), and top-level `await` is used in `main.ts`.
- **Vitest, not Jest**: use `vi.fn()`; `globals: true` so `describe/it/expect` need no import. Path aliases from `tsconfig.json` are resolved via `resolve.tsconfigPaths` (Vite 8).
- Decorators rely on `experimentalDecorators` + `emitDecoratorMetadata`.
- Validation: prefer `StandardSchemaValidationPipe` (Zod/Valibot/etc.) per `AGENTS.md`; `class-validator` is also supported via `ValidationPipe`. En `api` el pipe de schemas ya es global (ver "Seguridad").
- Observability is not wired up until `ObserveModule` is registered in `apps/api/src/api.module.ts` (`npx @nestjs/observe link`).
