# Mini-Croper — Backend

Backend de **Mini-Croper**, un marketplace agropecuario multi-vendedor con pago virtual simulado. Está hecho con NestJS 12, MongoDB (Mongoose) y RabbitMQ, como monorepo de Nest CLI con arquitectura híbrida: un monolito modular y un servicio de notificaciones aparte.

| App | Ruta | Puerto | Contenido | Swagger |
| --- | --- | --- | --- | --- |
| `api` | `apps/api` | 3000 | Módulos `auth`, `catalog`, `order` y `payments`. Es la única entrada pública. | `/docs` |
| `notifications` | `apps/notifications` | 3005 | Consume eventos de RabbitMQ y envía avisos simulados. | `/docs` |

```text
cliente ──HTTP──▶ api (:3000) ──eventos──▶ RabbitMQ ──▶ notifications (:3005)
                    │                                        │
                 MongoDB                                  MongoDB
             (base mini-croper)               (base mini-croper-notifications)
```

Rutas del monolito: `/auth`, `/catalog`, `/orders`, `/payments` y `GET /health`.

## Requisitos

- **Node.js 24** (mínimo 22.18: `npm run seed:admin` ejecuta TypeScript directamente con Node) y npm.
- **Docker** con Docker Compose (levanta MongoDB y RabbitMQ).
- Puertos libres: `3000`, `3005`, `27017`, `5672` y `15672`.

## Puesta en marcha

### 1. Instalar dependencias

```bash
git clone <url-del-repositorio>
cd agro-app-workspace
npm install
```

### 2. Levantar MongoDB y RabbitMQ

```bash
docker compose up -d --wait
```

Esto arranca MongoDB 8 como **replica set de un nodo** (`rs0`, obligatorio porque la app usa transacciones) y RabbitMQ 4. El comando espera a que ambos estén sanos. Las credenciales de RabbitMQ ya están en el `docker-compose.yml` y coinciden con `.env.example`.

### 3. Crear el archivo `.env`

```bash
# Git Bash / Linux / macOS
cp .env.example .env
```

```powershell
# PowerShell
Copy-Item .env.example .env
```

### 4. Generar las claves JWT

```bash
npm run keys:generate
```

Imprime dos líneas, `JWT_PRIVATE_KEY=...` y `JWT_PUBLIC_KEY=...`. Pégalas en `.env`, reemplazando las líneas vacías que ya existen. El comando no escribe nada en disco.

### 5. Definir el secreto del webhook de pagos

En `.env`, cambia `PAYMENTS_WEBHOOK_SECRET` por un valor propio de **al menos 32 caracteres**, por ejemplo con `openssl rand -hex 32`. El valor de ejemplo sirve para desarrollo.

### 6. Crear el primer usuario ADMIN

El registro público nunca crea administradores, así que el primero se crea con un script. Pasa las credenciales en el comando; no las dejes en `.env`.

La contraseña debe tener al menos 10 caracteres, una mayúscula, una minúscula y un número.

```bash
# Git Bash / Linux / macOS
ADMIN_EMAIL=admin@correo.com ADMIN_PASSWORD='Admin12345!' npm run seed:admin
```

```powershell
# PowerShell
$env:ADMIN_EMAIL = 'admin@correo.com'; $env:ADMIN_PASSWORD = 'Admin12345!'; npm run seed:admin
```

El script es idempotente: si el email ya es ADMIN no hace nada.

### 7. Arrancar las apps

Cada app va en su propia terminal.

**Desarrollo (con recarga automática):**

```bash
npm run start:dev                  # api → http://localhost:3000
npm run start:dev:notifications    # notifications → http://localhost:3005
```

**Producción (compilado):**

```bash
npm run build:all
npm run start:prod                 # api
npm run start:prod:notifications   # notifications
```

> La API arranca aunque `notifications` o RabbitMQ no estén disponibles: los eventos quedan en una bandeja de salida y se publican cuando el broker vuelva. Para ver las notificaciones, `notifications` debe estar corriendo.

## Comprobar que funciona

| Qué | Dónde |
| --- | --- |
| Estado de `api` y MongoDB | `GET http://localhost:3000/health` (200 si todo bien, 503 si MongoDB no responde) |
| Estado de `notifications` | `GET http://localhost:3005/health` |
| Swagger de la API (probar endpoints) | http://localhost:3000/docs |
| Consola de RabbitMQ | http://localhost:15672 (usuario `mini-croper`, clave `mini-croper-dev`) |

Con `NODE_ENV=production` Swagger **no se publica**. Para evaluar la API desde Swagger, déjalo en `development`.

## Flujo de prueba rápido

Desde Swagger (`/docs`), usando **Authorize** con el `accessToken` del login:

1. `POST /auth/login` con el ADMIN creado en el paso 6.
2. `POST /auth/register` para registrar un usuario con rol PROVEEDOR (queda pendiente de aprobación).
3. `GET /auth/users` (como ADMIN) para obtener su `id` y `POST /auth/users/:id/approve` para aprobarlo.
4. Comprobar la notificación: en la base `mini-croper` la colección `notification_outbox` queda en estado `PUBLISHED`, y en la base `mini-croper-notifications` aparece un documento en la colección `notifications`.

El resto de reglas (roles, catálogo, carrito, pedidos, pagos simulados) está en [`docs/reglas-de-negocio.md`](docs/reglas-de-negocio.md).

## Variables de entorno

Se leen del archivo `.env` en la raíz o del entorno del sistema. Si falta una obligatoria, la app no arranca y el error nombra la variable.

| Variable | Obligatoria | Usada por | Nota |
| --- | --- | --- | --- |
| `MONGODB_URI` | Sí | `api`, `notifications` | Debe apuntar a un replica set. Cada app fija su propia base en el código. |
| `RABBITMQ_URI` | Sí | `api`, `notifications` | `amqp://usuario:clave@host:5672` |
| `JWT_PRIVATE_KEY` | Sí | `api` | PEM RSA de 2048 bits o más; admite `\n` escapados. |
| `JWT_PUBLIC_KEY` | Sí | `api` | PEM correspondiente. |
| `PAYMENTS_WEBHOOK_SECRET` | Sí | `api` | Secreto HMAC del webhook de pagos, mínimo 32 caracteres. |
| `CORS_ORIGINS` | No | `api` | Orígenes permitidos separados por comas. Vacío = sin CORS. |
| `NODE_ENV` | No | ambas | `production` desactiva Swagger. |
| `PORT` | No | ambas | Por defecto 3000 (`api`) y 3005 (`notifications`). |

## Pruebas

```bash
npm test          # unitarios
npm run test:e2e  # extremo a extremo
npm run lint
```

Los e2e necesitan MongoDB y RabbitMQ arriba (`docker compose up -d --wait`) y el `.env` configurado. Generan sus propias claves JWT, **vacían la cola `notifications.events`** y crean usuarios `e2e-*@test.co` en la base `mini-croper`, que borran al terminar.

## Detener

```bash
docker compose down       # detiene los contenedores y conserva los datos
docker compose down -v    # además borra los volúmenes (base de datos y colas)
```

## Problemas frecuentes

- **La app no arranca y nombra una variable:** falta o es inválida en `.env` (típico: las claves JWT sin pegar).
- **Errores de transacción en MongoDB:** MongoDB no está como replica set. Usa el `docker-compose.yml` del proyecto y la URI de `.env.example` (`?replicaSet=rs0&directConnection=true`).
- **`EADDRINUSE`:** otro proceso usa el puerto; cambia `PORT` o libéralo. Revisa también si ya tienes un MongoDB o RabbitMQ local en 27017 o 5672.
- **`seed:admin` falla al leer `.ts`:** tu versión de Node es anterior a 22.18.
- **`seed:admin` rechaza la contraseña:** no cumple la política (10+ caracteres, mayúscula, minúscula y número).

## Documentación adicional

- [`docs/reglas-de-negocio.md`](docs/reglas-de-negocio.md): reglas de negocio vigentes.
- [`CLAUDE.md`](CLAUDE.md): arquitectura, seguridad, mensajería y convenciones del código.
- `specs/`: especificaciones por módulo.
