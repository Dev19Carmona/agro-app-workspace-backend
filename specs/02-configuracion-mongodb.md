# SPEC 02 — Configuración de MongoDB

> **Status:** Aprobado
> **Depends on:** SPEC 01
> **Date:** 2026-11-06
> **Objective:** Conectar el monolito `api` y el servicio `notifications` a MongoDB (local en Docker como replica set), con configuración validada, `GET /health` y las reglas de negocio adaptadas a MongoDB.

## Por qué existe este spec

`docs/reglas-de-negocio.md` fue escrito asumiendo una base relacional: la reserva de stock usa un bloqueo de filas propio de SQL, el outbox es una "tabla" y cada módulo tiene "tablas propias". Al elegir MongoDB esas reglas deben decir lo mismo con términos de documentos, y el stack (Mongoose, replica set, Docker) debe quedar escrito en `CLAUDE.md`.

Las reglas de negocio solo reciben una nota de persistencia y el cambio de términos. La decisión técnica va en `CLAUDE.md`, porque las reglas no llevan decisiones de stack.

## Alcance

**Dentro:**

- `docker-compose.yml` con `mongo:8` como replica set `rs0` de un nodo, volumen persistente y healthcheck que ejecuta `rs.initiate` de forma idempotente.
- `.env.example` versionado con `MONGODB_URI=mongodb://localhost:27017/?replicaSet=rs0&directConnection=true`. El `.env` local ya está ignorado por git.
- `ConfigModule` global (`@nestjs/config`) en `apps/api` y `apps/notifications`.
- Schema Zod compartido en `libs/common/src/config/env.schema.ts`: `MONGODB_URI` obligatoria y `PORT` opcional. Si falta la URI, la app no arranca.
- `MongooseModule.forRootAsync` en `ApiModule` con `dbName: 'mini-croper'` y en `NotificationsModule` con `dbName: 'mini-croper-notifications'`.
- `HealthModule` compartido en `libs/common/src/health/`: `GET /health` con `@nestjs/terminus` y `MongooseHealthIndicator.pingCheck('mongodb')`. Responde 200 si Mongo contesta y 503 si no. Se registra en las dos apps con el tag Swagger `health`.
- Cambios en `docs/reglas-de-negocio.md`:
  - Nueva sección corta "Persistencia" (MongoDB; cada módulo es dueño de sus colecciones).
  - Saga, paso 2: el bloqueo de filas de SQL pasa a ser una actualización atómica condicional por variante (`stock − stockReservado ≥ cantidad`) dentro de una transacción.
  - Garantías de entrega: `outbox_events` pasa de "tabla" a "colección", escrita en la misma transacción que el cambio de estado.
  - Nueva fila en "Historial de cambios" y fecha de última actualización.
- Cambios en `CLAUDE.md`:
  - Arquitectura: MongoDB con Mongoose, una base de datos por app, replica set requerido para transacciones.
  - Comandos: `docker compose up -d` y copiar `.env.example` a `.env`.

**Fuera de alcance (para specs futuros):**

- Schemas y colecciones de dominio (`User`, `Store`, `Product`, `Order`, `Payment`, `OutboxEvent`). Cada uno va en el spec de su dominio.
- Idempotencia de consumidores en `notifications` (guardar `eventId` procesados).
- Transporte de eventos hacia `notifications`.
- Migraciones y datos semilla.
- MongoDB Atlas y despliegue a producción.
- `ObserveModule`.
- Contenerizar las apps en Docker.

## Modelo de datos

Este spec no crea colecciones. Fija la conexión y el esquema de variables de entorno.

```ts
// libs/common/src/config/env.schema.ts
const envSchema = z.object({
  MONGODB_URI: z.string().url(),
  PORT: z.coerce.number().optional(),
});
```

| App | Base de datos | Puerto |
| --- | --- | --- |
| `api` | `mini-croper` | 3000 |
| `notifications` | `mini-croper-notifications` | 3005 |

Convenciones:

- Una sola variable `MONGODB_URI` sirve para las dos apps; el `dbName` se fija en el código de cada una.
- Las colecciones se nombran en el spec de cada dominio, y cada módulo es dueño de las suyas.

## Plan de implementación

1. Añadir `docker-compose.yml` y `.env.example`. Prueba manual: `docker compose up -d` y `rs.status()` responde `ok: 1`.
2. Instalar `@nestjs/config` y `zod`. Crear `libs/common/src/config/env.schema.ts` con su `.spec.ts` (acepta una URI válida, rechaza una ausente o inválida).
3. Registrar `ConfigModule.forRoot({ isGlobal: true, validate })` en `ApiModule` y en `NotificationsModule`.
4. Instalar `@nestjs/mongoose` y `mongoose`. Añadir `MongooseModule.forRootAsync` con el `dbName` de cada app.
5. Instalar `@nestjs/terminus`. Crear `libs/common/src/health/` (módulo y controlador con su `.spec.ts`, usando mocks de `HealthCheckService`). Registrarlo en las dos apps con el tag Swagger `health`.
6. Actualizar `docs/reglas-de-negocio.md` (sección "Persistencia", saga, outbox, historial y fecha).
7. Actualizar `CLAUDE.md` (arquitectura y comandos).

## Criterios de aceptación

- [ ] Con `docker compose up -d`, el contenedor de Mongo queda `healthy` y el replica set `rs0` está iniciado.
- [ ] Sin `MONGODB_URI`, `npm run start:dev` falla al arrancar con un error que nombra la variable.
- [ ] Con Mongo arriba, `GET http://localhost:3000/health` devuelve 200 con `mongodb: up`.
- [ ] Con Mongo arriba, `GET http://localhost:3005/health` devuelve 200 con `mongodb: up`.
- [ ] Con Mongo detenido, las dos rutas `/health` devuelven 503.
- [ ] `api` se conecta a la base de datos `mini-croper` y `notifications` a `mini-croper-notifications`.
- [ ] `.env` no está versionado y `.env.example` sí.
- [ ] `docs/reglas-de-negocio.md` ya no describe la reserva con un bloqueo de filas de SQL ni habla de "tablas", y tiene la entrada nueva en el historial.
- [ ] `CLAUDE.md` documenta MongoDB y el comando `docker compose up -d`.
- [ ] `npm run build:all`, `npm run lint` y `npm test` terminan sin errores.

## Decisiones

- **Sí:** `@nestjs/mongoose`. Es la integración oficial de Nest y encaja con los decoradores ya activos.
- **No:** driver nativo `mongodb`. Obliga a escribir a mano la capa de esquemas.
- **No:** Prisma. Su soporte de MongoDB es más limitado.
- **Sí:** Docker Compose local con replica set de un nodo. Las transacciones (reserva de stock y outbox) lo exigen y el entorno es reproducible.
- **No:** MongoDB Atlas. Depende de internet y de una cuenta para desarrollar.
- **Sí:** `@nestjs/config` con validación Zod. `AGENTS.md` prefiere Standard Schema y el error aparece al arrancar, no después.
- **No:** `process.env` sin validar. Los errores aparecerían tarde y lejos de la causa.
- **Sí:** `GET /health` con `@nestjs/terminus`. Es el health check estándar de Nest y las reglas ya lo listan como entregable.
- **Sí:** una base de datos por app con `dbName` fijo en el código. Evita que las dos apps crucen datos con un solo `.env`.
- **Sí:** `HealthModule` y el schema de entorno en `libs/common`. Así no se duplican en las dos apps.
- **Sí:** en las reglas solo va la nota de persistencia y el cambio de términos. El stack va en `CLAUDE.md`.
- **No:** crear schemas de dominio en este spec. Tocaría cuatro módulos y el spec sería demasiado grande.
- **No:** editar `specs/01-reglas-de-negocio.md`. Ya no se mantiene.

## Riesgos

| Riesgo | Mitigación |
| --- | --- |
| `@nestjs/mongoose` o `@nestjs/terminus` aún no declaran compatibilidad con NestJS 12 | Revisar `peerDependencies` al instalar. Si hay conflicto, registrarlo y pedir aprobación antes de usar `--legacy-peer-deps`. |
| El replica set no se inicia y las transacciones fallan | Healthcheck idempotente con `rs.initiate` y `directConnection=true` en la URI. |
| Las dos apps comparten instancia y podrían cruzar datos | `dbName` distinto por app, fijado en el código. |
| ESM: imports relativos sin `.js` rompen el build | Seguir la convención del repo (`./archivo.js`). |

## Qué **no** está en este spec

- Schemas y colecciones de dominio.
- Idempotencia de consumidores en `notifications` y transporte de eventos.
- Migraciones y datos semilla.
- Atlas y producción.
- `ObserveModule`.
- Contenerizar las apps.

Cada uno de estos, si se aborda, va en su propio spec.
