# SPEC 03 — Módulo Auth y seguridad transversal

> **Status:** Aprobado
> **Depends on:** SPEC 01, SPEC 02
> **Date:** 2026-11-06
> **Objective:** Implementar el módulo `auth` del monolito `api` (registro con aprobación de PROVEEDOR, login, JWT RS256, refresh con rotación, gestión de usuarios por ADMIN) junto con la base de seguridad transversal que lo sostiene (guards globales, validación estricta, helmet, CORS y rate limiting).

## Por qué existe este spec

`docs/reglas-de-negocio.md` ("Seguridad y permisos") fija el comportamiento, pero hoy `auth` es un esqueleto vacío y `main.ts` no aplica ningún control: sin guard global, sin helmet, sin límites de peticiones y sin validación de entrada. Los demás dominios (catálogo, pedidos, pagos) dependen de que el JWT, los roles y los límites existan antes de escribir sus endpoints.

Además, este spec introduce una regla de negocio nueva: **un PROVEEDOR no se registra solo; envía una solicitud y un ADMIN la aprueba o la rechaza.** Esa regla se agrega a `docs/reglas-de-negocio.md` en el mismo cambio.

El módulo se organiza con las guías de la skill `nestjs-best-practices` (`arch-feature-modules`, `security-auth-jwt`, `security-use-guards`, `security-validate-all-input`, `security-rate-limiting`, `error-throw-http-exceptions`, `devops-use-config-module`).

## Alcance

**Dentro:**

- **Endpoints públicos** (`@Public()`): `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`.
- **Endpoints autenticados:** `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password`.
- **Endpoints solo ADMIN** (`@Roles(Role.ADMIN)`):
  - `GET /auth/users` (paginado, filtros por `rol` y `status`).
  - `GET /auth/users/:id`.
  - `POST /auth/users/:id/approve` y `POST /auth/users/:id/reject` (solicitudes de PROVEEDOR).
  - `POST /auth/users/:id/disable` y `POST /auth/users/:id/enable`.
  - `PATCH /auth/users/:id/role`.
- **Registro público:** el body elige `rol` entre `PRODUCTOR` y `PROVEEDOR`; nunca `ADMIN`. Exige `aceptaTratamientoDatos: true` (Habeas Data) y guarda el consentimiento con fecha.
  - `PRODUCTOR` queda `ACTIVE` al registrarse.
  - `PROVEEDOR` queda `PENDING_APPROVAL` y no puede iniciar sesión hasta que un ADMIN lo apruebe.
  - Un `REJECTED` no puede volver a registrarse con ese email.
- **Tokens:** access token JWT RS256 de 15 min; refresh token opaco de 7 días, guardado con hash, rotado en cada uso, con detección de reuso que revoca toda la sesión (familia).
- **Contraseñas:** `bcrypt` con costo 12; mínimo 10 caracteres, máximo 72 bytes, con mayúscula, minúscula y número; no puede contener el email.
- **Bloqueo de login:** 5 intentos fallidos bloquean la cuenta 15 min (`failedLoginAttempts`, `lockedUntil` en el `User`).
- **Seguridad transversal** en `libs/common/src/security/` y `main.ts`:
  - Guards globales vía `APP_GUARD`, en este orden: `ThrottlerGuard`, `JwtAuthGuard`, `RolesGuard`. Todo endpoint es privado salvo que lleve `@Public()`.
  - Decoradores compartidos `@Public()`, `@Roles(...)`, `@CurrentUser()` y el tipo `AuthenticatedUser`, para que otros módulos no importen archivos internos de `auth`.
  - Rate limiting con `@nestjs/throttler`: 100 req/min por IP global; 5/min en `/auth/login`, `/auth/register` y `/auth/change-password`; 10/min en `/auth/refresh`.
  - `helmet`, CORS con lista blanca desde `CORS_ORIGINS` (vacía = sin orígenes cruzados), `x-powered-by` desactivado y límite de tamaño del body.
  - Validación de entrada con Zod estricto (`z.strictObject`) mediante `StandardSchemaValidationPipe`: rechaza propiedades desconocidas (mass assignment) y tipos no esperados (inyección de operadores `$ne`, `$gt` en Mongo).
  - Swagger con esquema `bearer` y desactivado cuando `NODE_ENV=production`.
- **Eventos en memoria** con `@nestjs/event-emitter`: `user.registered`, `provider.approved`, `provider.rejected` (sin consumidor aún).
- **Variables de entorno nuevas** validadas con Zod al arrancar `api`: `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `CORS_ORIGINS` (opcional), `NODE_ENV` (opcional).
- **Scripts npm:** `keys:generate` (genera el par RSA para pegar en `.env`) y `seed:admin` (crea el primer ADMIN desde `ADMIN_EMAIL` y `ADMIN_PASSWORD`).
- **Documentación:** actualizar `docs/reglas-de-negocio.md` y `CLAUDE.md`.

**Fuera de alcance (para specs futuros):**

- Verificación de email y recuperación de contraseña (necesitan envío de correo vía `notifications`, cuyo transporte aún no existe).
- Correo al proveedor por aprobación o rechazo: se conectará en el spec de notificaciones, que consumirá los eventos ya emitidos.
- MFA, OAuth y login social.
- Rotación de claves JWT con `kid`/JWKS.
- Lista de revocación de access tokens (el access token de 15 min no se revoca; ver Riesgos).
- Reglas de propiedad por recurso (PROVEEDOR solo su `storeId`, PRODUCTOR solo sus pedidos): van en el spec de cada dominio, usando `@CurrentUser()`.
- Asignación de `storeId` al PROVEEDOR: la hace el módulo `catalog` al crear la tienda.
- Endpoints `/internal/*` con token de servicio y rate limit de `/payments` (10/min): van con `payments` y `notifications`.
- Almacenamiento compartido del throttler (Redis) para varias instancias.
- Auditoría de intentos de login en una colección aparte.
- Protección de `notifications`: no se toca esta app.

## Modelo de datos

Colecciones propias del módulo `auth` (Mongoose, base `mini-croper`). Ningún otro módulo las lee directamente.

```ts
// apps/api/src/modules/auth/schemas/user.schema.ts  → colección `users`
type User = {
  _id: ObjectId;
  email: string; // minúsculas, índice único
  passwordHash: string; // bcrypt costo 12; nunca sale en respuestas ni logs
  nombre: string;
  documento: string; // nunca se registra completo en logs
  rol: 'PRODUCTOR' | 'PROVEEDOR' | 'ADMIN';
  status: 'ACTIVE' | 'PENDING_APPROVAL' | 'REJECTED' | 'DISABLED';
  storeId?: ObjectId; // lo asigna `catalog`; ausente hasta entonces
  consent: { acceptedAt: Date; version: string }; // Habeas Data
  failedLoginAttempts: number; // default 0
  lockedUntil?: Date;
  rejectionReason?: string;
  reviewedBy?: ObjectId; // ADMIN que aprobó o rechazó
  reviewedAt?: Date;
  passwordChangedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

// apps/api/src/modules/auth/schemas/refresh-token.schema.ts → colección `refresh_tokens`
type RefreshToken = {
  _id: ObjectId;
  userId: ObjectId; // índice
  familyId: string; // uuid; identifica una sesión y sus rotaciones
  tokenHash: string; // SHA-256 del token opaco; índice único
  expiresAt: Date; // índice TTL: Mongo borra el documento al vencer
  revokedAt?: Date;
  replacedBy?: ObjectId; // token que lo reemplazó al rotar
  createdAt: Date;
};
```

Claims del access token (RS256, `iss: 'mini-croper'`, `aud: 'mini-croper-api'`, `exp` 15 min):

```ts
type AccessTokenPayload = { sub: string; rol: Role; sid: string; storeId?: string };
```

`AuthenticatedUser` (lo que expone `@CurrentUser()`): `{ id, rol, sessionId, storeId? }`.

Transiciones de `status`:

```text
register PRODUCTOR → ACTIVE
register PROVEEDOR → PENDING_APPROVAL → (approve) ACTIVE | (reject) REJECTED
ACTIVE ⇄ DISABLED (ADMIN)
```

Variables de entorno nuevas (schema `apiEnvSchema` en `libs/common/src/config/env.schema.ts`, usado solo por `api` para no exigirlas a `notifications`):

| Variable | Obligatoria | Nota |
| --- | --- | --- |
| `JWT_PRIVATE_KEY` | Sí | PEM RSA ≥ 2048 bits; admite `\n` escapados |
| `JWT_PUBLIC_KEY` | Sí | PEM correspondiente |
| `CORS_ORIGINS` | No | Lista separada por comas; vacía = sin CORS |
| `NODE_ENV` | No | `production` desactiva Swagger |

`ADMIN_EMAIL` y `ADMIN_PASSWORD` solo los lee el script `seed:admin`, no la app.

Respuestas de error:

- Credenciales inválidas, usuario inexistente y cuenta bloqueada responden igual: `401 Credenciales inválidas`. El bloqueo no revela que la cuenta existe.
- `PENDING_APPROVAL`, `REJECTED` y `DISABLED` responden `403` solo después de validar bien la contraseña.
- Email duplicado en registro: `409`.
- Error de clave duplicada de Mongo (código 11000): se traduce a `409`, nunca a `500`.

Estructura de archivos del módulo:

```text
apps/api/src/modules/auth/
  auth.module.ts
  auth.controller.ts            # público y autenticado
  users-admin.controller.ts     # solo ADMIN
  auth.service.ts               # registro, login, refresh, logout, change-password
  users.service.ts              # consultas y revisión de usuarios
  token.service.ts              # access token y refresh con rotación
  password.service.ts           # bcrypt y política de contraseña
  auth.events.ts                # nombres y payloads de eventos
  dto/                          # schemas Zod de entrada
  schemas/                      # user.schema.ts, refresh-token.schema.ts
libs/common/src/security/
  security.module.ts            # JwtModule (solo verificar), Throttler, APP_GUARD
  jwt-auth.guard.ts
  roles.guard.ts
  decorators.ts                 # @Public, @Roles, @CurrentUser
  roles.ts                      # enum Role y AuthenticatedUser
  apply-security.ts             # helmet, CORS, límites
scripts/
  generate-jwt-keys.mjs
  seed-admin.ts
```

## Plan de implementación

Cada paso deja el sistema compilando y con `npm test` en verde.

1. **Dependencias y entorno.** Instalar `@nestjs/jwt`, `@nestjs/throttler`, `@nestjs/event-emitter`, `helmet`, `bcrypt` y `@types/bcrypt`. Añadir `apiEnvSchema` (con su `.spec.ts`: acepta PEM válido, rechaza ausente o clave corta), `scripts/generate-jwt-keys.mjs`, el script `keys:generate` y los placeholders en `.env.example`. Usar `apiEnvSchema` en `ApiModule`.
2. **Primitivas de seguridad.** Crear `roles.ts` y `decorators.ts` en `libs/common/src/security/`, con spec de los decoradores.
3. **Guards globales.** Implementar `JwtAuthGuard` (verifica con la clave pública, fija `algorithms: ['RS256']`, `issuer` y `audience`, respeta `@Public()`) y `RolesGuard` (exige `@Roles` si está presente), con specs. Crear `SecurityModule` con `ThrottlerModule` (100/min) y los tres `APP_GUARD`; importarlo en `ApiModule`. Marcar `GET /health` como `@Public()`. Comprobación manual: `GET /catalog` sin token responde 401 y `/health` responde 200.
4. **Endurecimiento HTTP.** Crear `apply-security.ts` (helmet, CORS desde `CORS_ORIGINS`, `x-powered-by` fuera, límite de body) y llamarlo en `main.ts`. Añadir `addBearerAuth` a `setupSwagger` y omitir Swagger si `NODE_ENV=production`.
5. **Schemas.** Crear `user.schema.ts` y `refresh-token.schema.ts` con sus índices (email único, `tokenHash` único, TTL en `expiresAt`) y registrarlos en `AuthModule` con `MongooseModule.forFeature`.
6. **Contraseñas.** Implementar `PasswordService` (hash, comparación y política) con spec. La comparación contra un usuario inexistente usa un hash falso para igualar tiempos.
7. **Tokens.** Implementar `TokenService`: firmar access token con la clave privada, emitir refresh opaco (32 bytes aleatorios, SHA-256 en base), rotar y detectar reuso con revocación de la familia. Spec con los casos: rotación normal, reuso, expirado, revocado.
8. **Registro y login.** Implementar `register` y `login` en `AuthService` con DTO Zod estricto, bloqueo de 5 intentos / 15 min, manejo de `status`, `@Throttle` de 5/min y emisión de `user.registered`. Spec del servicio y del controlador.
9. **Sesión.** Implementar `refresh`, `logout`, `GET /auth/me` y `change-password` (verifica la actual, revoca todos los refresh del usuario, actualiza `passwordChangedAt`). Specs.
10. **Administración de usuarios.** Implementar `UsersService` y `UsersAdminController`: listado paginado (límite máximo de página), detalle, `approve`/`reject` (solo PROVEEDOR en `PENDING_APPROVAL`; guardan `reviewedBy`/`reviewedAt`; emiten `provider.approved`/`provider.rejected`), `disable`/`enable` y cambio de rol. Un ADMIN no puede modificarse a sí mismo. `disable` y el cambio de rol revocan los refresh tokens del usuario. Specs.
11. **Seed del primer ADMIN.** Crear `scripts/seed-admin.ts` y el script `seed:admin`: lee `ADMIN_EMAIL` y `ADMIN_PASSWORD`, aplica la misma política de contraseña, es idempotente y no tiene credenciales por defecto.
12. **E2E del flujo.** Crear `apps/api/test/auth.e2e-spec.ts` con el flujo completo contra MongoDB (ver criterios).
13. **Documentación.** Actualizar `docs/reglas-de-negocio.md` (regla de aprobación del PROVEEDOR, estados del usuario, política de contraseña, bloqueo de 15 min, eventos nuevos, fecha e historial) y `CLAUDE.md` (variables nuevas, `keys:generate`, `seed:admin`, guard global y `@Public()`).

## Criterios de aceptación

- [ ] Sin `JWT_PRIVATE_KEY` o `JWT_PUBLIC_KEY`, `npm run start:dev` falla al arrancar con un error que nombra la variable; `notifications` sigue arrancando sin ellas.
- [ ] `npm run keys:generate` imprime un par PEM que, pegado en `.env`, permite arrancar `api`.
- [ ] Cualquier ruta sin `@Public()` responde 401 sin token, con token malformado, con firma inválida, con token expirado y con un token firmado con `HS256` o `alg: none`.
- [ ] `GET /health`, `POST /auth/register`, `POST /auth/login` y `POST /auth/refresh` responden sin token.
- [ ] Registrar un PRODUCTOR devuelve 201 sin `passwordHash` en el cuerpo y deja `status: ACTIVE`.
- [ ] Registrar con `rol: "ADMIN"` devuelve 400.
- [ ] Registrar con una propiedad desconocida (p. ej. `status`) o sin `aceptaTratamientoDatos: true` devuelve 400.
- [ ] Un email enviado como objeto (`{"$ne": null}`) en `/auth/login` devuelve 400 y no consulta Mongo.
- [ ] Registrar un PROVEEDOR deja `status: PENDING_APPROVAL`; su login con contraseña correcta devuelve 403 y no emite tokens.
- [ ] Tras `approve` por un ADMIN, el PROVEEDOR inicia sesión con 200 y se emite `provider.approved`; tras `reject`, su login devuelve 403, queda `rejectionReason` y no puede registrarse otra vez con ese email (409).
- [ ] Un PRODUCTOR o PROVEEDOR que llama a `GET /auth/users` recibe 403; un ADMIN recibe 200.
- [ ] Login con email inexistente y con contraseña incorrecta devuelven exactamente el mismo status y mensaje (401).
- [ ] Tras 5 logins fallidos, el sexto con la contraseña correcta devuelve 401 y `lockedUntil` queda ~15 min adelante; pasado ese tiempo el login funciona y `failedLoginAttempts` vuelve a 0.
- [ ] El access token decodificado tiene `alg: RS256`, `exp − iat = 900` y no contiene email ni documento.
- [ ] `POST /auth/refresh` devuelve un refresh token nuevo y deja el anterior revocado; reutilizar el anterior devuelve 401 y revoca toda la familia (el refresh nuevo también deja de funcionar).
- [ ] En `refresh_tokens` solo existe `tokenHash`; el token en claro no aparece en la base.
- [ ] `POST /auth/logout` revoca la sesión; su refresh token ya no sirve.
- [ ] `change-password` con la contraseña actual errónea devuelve 401; con la correcta revoca todos los refresh tokens del usuario.
- [ ] Contraseñas de 9 caracteres, de más de 72 bytes, sin mayúscula, sin número o que contengan el email devuelven 400.
- [ ] `disable` sobre un usuario revoca sus refresh tokens y su login pasa a devolver 403; un ADMIN que intenta `disable` o cambiarse el rol a sí mismo recibe 403.
- [ ] 6 peticiones seguidas a `/auth/login` desde la misma IP devuelven 429 en la sexta; 101 peticiones a cualquier ruta en un minuto devuelven 429.
- [ ] Las respuestas incluyen las cabeceras de `helmet` (`X-Content-Type-Options`, `Strict-Transport-Security`) y no incluyen `X-Powered-By`.
- [ ] Una petición con `Origin` fuera de `CORS_ORIGINS` no recibe `Access-Control-Allow-Origin`.
- [ ] Con `NODE_ENV=production`, la ruta de Swagger responde 404; sin él, Swagger muestra el botón «Authorize» con esquema bearer.
- [ ] Una clave duplicada de Mongo en el registro devuelve 409, no 500.
- [ ] Ningún log del arranque ni de las pruebas e2e contiene contraseñas, tokens ni el documento completo.
- [ ] `npm run seed:admin` crea el ADMIN, una segunda ejecución no lo duplica y falla si `ADMIN_PASSWORD` incumple la política.
- [ ] `docs/reglas-de-negocio.md` documenta la aprobación de PROVEEDOR, los estados del usuario, la política de contraseña, el bloqueo de 15 min y los dos eventos nuevos, y tiene entrada nueva en el historial.
- [ ] `CLAUDE.md` documenta `keys:generate`, `seed:admin` y las variables nuevas.
- [ ] `npm run build:all`, `npm run lint`, `npm test` y `npm run test:e2e` terminan sin errores.

## Decisiones

- **Sí:** un solo spec con Auth más la base transversal. Los guards globales, el throttler y la validación son lo que hace segura a Auth y el resto de módulos los hereda.
- **No:** separar el hardening en otro spec. Dejaría a `auth` expuesto sin límites durante el desarrollo de los demás dominios.
- **Sí:** guard global con `@Public()` como excepción. Un endpoint nuevo nace privado; olvidar un decorador no abre una brecha. Es la defensa en profundidad de las reglas.
- **No:** `@UseGuards` manual en cada controlador. Un olvido deja la ruta abierta.
- **Sí:** guards, decoradores y tipo de usuario en `libs/common/src/security/`. Los módulos validan el JWT con la clave pública sin importar archivos internos de `auth`, como piden las reglas.
- **Sí:** guard propio con `@nestjs/jwt`, sin Passport. Menos dependencias, funciona con ESM y fija `algorithms` e `issuer` de forma explícita.
- **No:** Passport. Añade una capa de estrategias que aquí no aporta.
- **Sí:** RS256 con PEM en variables de entorno validadas por Zod. Es lo que piden las reglas; se valida al arrancar y es portable.
- **No:** claves en archivos del repo o generadas al arrancar. Las primeras se filtran fácil; las segundas invalidan tokens al reiniciar.
- **Sí:** `apiEnvSchema` separado del `envSchema` común. `notifications` no debe exigir claves JWT que no usa.
- **Sí:** refresh token opaco, guardado con SHA-256, con rotación y detección de reuso por familia. Un token robado y reutilizado cierra la sesión completa. SHA-256 basta porque el token tiene 256 bits de entropía; bcrypt aquí sería lento sin ganancia.
- **No:** refresh token en cookie. Exige CSRF, cookie-parser y CORS con credenciales, e incomoda a Swagger y a clientes móviles.
- **No:** refresh fijo de 7 días sin rotación. Un token robado serviría toda la semana.
- **Sí:** `bcrypt` costo 12, política de 10–72 bytes. 72 es el límite real de bcrypt; fijarlo evita el truncado silencioso. Cumple el mínimo de costo 10 de las reglas.
- **Sí:** bloqueo por cuenta en el `User` (Mongo) y throttler por IP. Los dos cubren amenazas distintas, y el contador sobrevive a reinicios.
- **Sí:** el login responde igual para email inexistente, contraseña errónea y cuenta bloqueada, y compara contra un hash falso cuando el usuario no existe. Evita enumeración de cuentas por mensaje y por tiempo.
- **Sí:** `403` para `PENDING_APPROVAL`/`REJECTED`/`DISABLED` solo tras validar la contraseña. El estado de la cuenta no se filtra a quien no la conoce.
- **Sí:** el PROVEEDOR no puede iniciar sesión mientras está pendiente. Cada guard del sistema se mantiene simple en vez de revisar un estado «limitado».
- **No:** login con acceso limitado para el PROVEEDOR pendiente.
- **Sí:** un `REJECTED` no puede re-registrarse con ese email. Evita spam de solicitudes; un ADMIN puede revertirlo a mano.
- **Sí:** el registro público nunca crea ADMIN; el primero sale de `seed:admin` y los siguientes los promueve un ADMIN. Evita escalada de privilegios.
- **No:** crear el ADMIN al arrancar la app con credenciales del entorno. Deja credenciales vivas en el proceso.
- **Sí:** Zod estricto con `StandardSchemaValidationPipe`. `AGENTS.md` lo prefiere y `strictObject` rechaza propiedades de más; exigir `string` frena la inyección de operadores Mongo.
- **Sí:** registro duplicado responde `409`. Revela que el email existe, pero está limitado a 5/min por IP; sin verificación de email no hay forma de avisar sin revelarlo.
- **Sí:** `@nestjs/event-emitter` para `user.registered`, `provider.approved` y `provider.rejected`. El transporte hacia `notifications` aún no existe y el outbox llega con `order`.
- **No:** correo al proveedor en este spec. Depende de `notifications`.
- **Sí:** el access token no se revoca. Se acepta una ventana máxima de 15 min tras `disable` o cambio de rol, a cambio de validar sin consultar la base (ver Riesgos).
- **No:** lista de revocación de access tokens. Consultaría Mongo en cada petición y rompería la validación sin llamar a `auth`.
- **Sí:** throttler en memoria. Con una sola instancia es suficiente; Redis va cuando haya más.
- **Sí:** Swagger desactivado en producción. Expone toda la superficie de la API.

## Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Un usuario deshabilitado o con rol cambiado conserva un access token válido hasta 15 min | Ventana aceptada y documentada; `disable` y cambio de rol revocan los refresh tokens para que no pueda renovarlo. |
| `bcrypt` (módulo nativo) no compila o falla en Windows o con Node nuevo | Verificar la instalación en el paso 1; si falla, registrarlo y pedir aprobación antes de cambiar a `bcryptjs`. |
| `@nestjs/jwt`, `@nestjs/throttler` o `@nestjs/event-emitter` aún no declaran compatibilidad con NestJS 12 | Revisar `peerDependencies` al instalar; ante conflicto, pedir aprobación antes de usar `--legacy-peer-deps`. |
| Detrás de un proxy, el throttler vería la IP del proxy y limitaría a todos juntos | No se activa `trust proxy` por defecto; se decide con el despliegue. Documentado en `CLAUDE.md`. |
| Un cliente legítimo reintenta `/refresh` por una respuesta perdida y dispara la detección de reuso | Aceptado: obliga a iniciar sesión de nuevo, que es el lado seguro. |
| Un ADMIN se bloquea fuera del sistema | Un ADMIN no puede deshabilitarse ni cambiarse el rol, y `seed:admin` es idempotente para recuperar el acceso. |
| Rate limiting en memoria se pierde al reiniciar | Aceptado en una sola instancia; Redis queda para un spec futuro. |
| ESM: imports relativos sin `.js` rompen el build | Seguir la convención del repo (`./archivo.js`). |

## Qué **no** está en este spec

- Verificación de email y recuperación de contraseña.
- Correo al proveedor por aprobación o rechazo.
- MFA, OAuth y login social.
- Rotación de claves JWT (`kid`/JWKS) y revocación de access tokens.
- Reglas de propiedad por recurso y asignación de `storeId`.
- Endpoints `/internal/*`, rate limit de `/payments` y cualquier cambio en `notifications`.
- Throttler compartido (Redis) y auditoría de logins en colección aparte.

Cada uno de estos, si se aborda, va en su propio spec.
