# Mini-Croper — Arquitectura de Microservicios con NestJS

Nov 6, 2026 · @Camilo Carmona

## 1. Contexto y objetivo

Mini-Croper es un marketplace agropecuario multi-vendedor donde un productor compra insumos a varias tiendas en un solo pedido y lo paga con un pago virtual simulado. Se construye con 5 microservicios NestJS, un API Gateway y un broker RabbitMQ.

**Problema de negocio modelado** (tomado de croper.com):

- Catálogo de muchas tiendas (260+ en Croper) y categorías como fertilizantes, bioinsumos, semillas y maquinaria.
- Productos con **presentaciones** (1 L, 4 L, 20 L; 25 kg, 50 kg), cada una con precio y stock propios, y productos con **"precio a cotizar"**.
- Ofertas y productos promocionados por los vendedores.
- **Pago digital** del pedido, simulado como una pasarela de pagos (tarjeta, PSE, Nequi) sin dinero real.

**Actores y roles**

| Rol | Qué hace |
| --- | --- |
| PRODUCTOR | Busca productos, arma carrito, compra y paga |
| PROVEEDOR | Administra su tienda, productos, variantes y stock; ve sus sub-pedidos pagados |
| ADMIN | Gestiona usuarios, categorías y tiendas; consulta pagos |

**Alcance de la prueba:** autenticación, catálogo, pedidos, pago simulado y notificaciones. Quedan fuera pagos reales, crédito, logística y búsqueda avanzada (ver sección 8).

## 2. Vista general de la arquitectura

El cliente solo habla con el API Gateway; detrás, cinco servicios NestJS con base de datos propia se coordinan por eventos en RabbitMQ.

&#91;embedded content: Arquitectura Mini-Croper · gateway, 5 servicios, RabbitMQ\]

Las flechas sólidas son llamadas REST; las punteadas, eventos (doble punta = publica y consume). Además, Orders consulta precios a Catalog y Payments consulta el monto del pedido a Orders por HTTP interno. Servicios, bases y broker viven en una red Docker interna sin puertos expuestos.

## 3. Microservicios

Cada servicio es dueño de sus datos (*database per service*): ningún servicio lee la base de otro; se comunican por HTTP o eventos.

| Servicio | Puerto | Base de datos | Responsabilidad |
| --- | --- | --- | --- |
| api-gateway | 3000 | — | Punto único de entrada, valida JWT, rate limiting, enruta |
| auth-service | 3001 | auth\_db (PostgreSQL) | Registro, login, emisión y refresh de JWT, roles |
| catalog-service | 3002 | catalog\_db (PostgreSQL) | Tiendas, categorías, productos, variantes, stock y ofertas |
| order-service | 3003 | order\_db (PostgreSQL) | Carrito, checkout, pedidos y sub-pedidos por tienda |
| payment-service | 3004 | payment\_db (PostgreSQL) | Simula la pasarela: crea, procesa y registra pagos virtuales |
| notification-service | 3005 | — (logs) | Consume eventos y envía avisos (email/WhatsApp simulado) |

### 3.1 auth-service

- **Entidades:** `User` (id, email, passwordHash, nombre, documento, rol, storeId?), `RefreshToken`.
- **Endpoints:**
  - `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `GET /auth/me`
- **Evento publicado:** `user.registered`.

### 3.2 catalog-service

- **Entidades:** `Store` (id, nombre, nit, ownerId, municipio), `Category`, `Product` (id, storeId, categoryId, nombre, marca, fichaTécnica, requiresQuote), `ProductVariant` (id, productId, presentación, unidad, precio, precioOferta?, stock, stockReservado).
- **Endpoints:**
  - `GET /products?category=&storeId=&q=&page=` (público)
  - `GET /products/:id`, `GET /stores/:id`, `GET /offers` (públicos)
  - `POST /stores`, `POST /products`, `PATCH /variants/:id/stock` (PROVEEDOR, solo su tienda)
  - `POST /internal/variants/prices` (interno: precios vigentes para checkout)
- **Eventos:** consume `order.created`, `order.cancelled`; publica `stock.reserved`, `stock.rejected`, `stock.released`.

### 3.3 order-service

- **Entidades:** `Cart`, `CartItem`, `Order` (id, buyerId, total, status, expiresAt), `SubOrder` (por tienda), `OrderItem`, `OutboxEvent`.
- **Estados del pedido:** `PENDING` → `AWAITING_PAYMENT` → `CONFIRMED` | `CANCELLED`.
- **Endpoints:**
  - `GET/POST/DELETE /cart/items` (PRODUCTOR)
  - `POST /orders/checkout`, `GET /orders`, `GET /orders/:id` (PRODUCTOR)
  - `GET /stores/:storeId/sub-orders` (PROVEEDOR)
  - `GET /internal/orders/:id` (interno: monto y estado para payment-service)
- **Reglas clave:** el precio se toma del catálogo en el checkout, nunca del cliente. Productos `requiresQuote` no entran al checkout. Un pedido sin pago aprobado en 15 min expira y se cancela.

### 3.4 payment-service (pasarela simulada)

- **Entidades:** `Payment` (id, orderId, buyerId, monto, moneda COP, método: CARD | PSE | NEQUI, status, referencia, motivoRechazo, idempotencyKey), `PaymentAttempt` (historial de intentos).
- **Estados del pago:** `PENDING` → `PROCESSING` → `APPROVED` | `DECLINED` | `ERROR`.
- **Endpoints:**
  - `POST /payments` (PRODUCTOR; header `Idempotency-Key`; body: orderId, método, token de prueba)
  - `GET /payments/:id`, `GET /orders/:orderId/payments` (PRODUCTOR dueño o ADMIN)
  - `POST /payments/webhook` (simula la notificación asíncrona de la pasarela, firmada con HMAC)
- **Reglas de simulación** (el cliente nunca envía datos reales de tarjeta, solo un token de prueba):

| Token de prueba | Resultado | Motivo |
| --- | --- | --- |
| `tok_test_approved` | APPROVED | — |
| `tok_test_declined` | DECLINED | Fondos insuficientes |
| `tok_test_error` | ERROR | Falla de la pasarela (se puede reintentar) |
| `tok_test_pending` | Queda en PROCESSING | Se resuelve después vía webhook (simula PSE) |

- **Validaciones:** el monto se toma de order-service, nunca del cliente; solo se paga un pedido en `AWAITING_PAYMENT`; un pedido admite un único pago aprobado.
- **Eventos:** publica `payment.approved`, `payment.declined`.

### 3.5 notification-service

- Sin API pública. Consume `order.confirmed`, `order.cancelled`, `payment.*`, `user.registered` y registra o envía el mensaje al productor y al proveedor.

## 4. Comunicación

Las consultas usan HTTP síncrono; todo cambio de estado entre servicios viaja como evento por RabbitMQ, coordinado con una saga coreografiada.

### 4.1 Síncrona (HTTP/REST)

- Cliente → API Gateway → servicio, con JSON sobre HTTPS y prefijo `/api/v1`.
- Servicio → servicio solo para lecturas necesarias en el momento (order-service pide precios a catalog-service; payment-service pide monto y estado del pedido a order-service), usando `@nestjs/axios` con timeout de 2 s, 2 reintentos y un *circuit breaker* (`opossum`).
- Contratos documentados con `@nestjs/swagger` en cada servicio.

### 4.2 Asíncrona (eventos con RabbitMQ)

- Transporte nativo de NestJS: `Transport.RMQ` en `@nestjs/microservices`; publicación con `ClientProxy.emit()` y consumo con `@EventPattern()`.
- Un exchange tipo *topic* `agro.events` y una cola por servicio consumidor (`catalog.q`, `order.q`, `notification.q`).
- Formato de evento común: `{ eventId, type, occurredAt, correlationId, payload }`.

| Evento | Publica | Consume |
| --- | --- | --- |
| `order.created` | order | catalog |
| `stock.reserved` / `stock.rejected` | catalog | order |
| `payment.approved` / `payment.declined` | payment | order, notification |
| `order.confirmed` / `order.cancelled` | order | catalog, notification |
| `stock.released` | catalog | order |
| `user.registered` | auth | notification |

### 4.3 Saga: pedido con pago virtual

1. El productor hace `POST /orders/checkout`; order-service guarda el pedido en `PENDING` y emite `order.created`.
2. catalog-service reserva stock de cada variante (transacción con `SELECT … FOR UPDATE`).
   - Si alcanza: emite `stock.reserved` y el pedido pasa a `AWAITING_PAYMENT` (vence en 15 min).
   - Si no: emite `stock.rejected` y el pedido pasa a `CANCELLED`.
3. El productor paga con `POST /payments`; payment-service valida el monto con order-service y simula la transacción (1–3 s de latencia).
   - Aprobado: `payment.approved` → pedido `CONFIRMED` → `order.confirmed`.
   - Rechazado o error: `payment.declined` → el pedido sigue en `AWAITING_PAYMENT` y el productor puede reintentar.
4. Si el pedido vence sin pago aprobado, un job lo pasa a `CANCELLED` → `order.cancelled` → catalog libera el stock (**compensación**).
5. notification-service avisa al productor y a cada tienda del resultado.

### 4.4 Garantías de entrega

- **Outbox pattern:** el evento se guarda en la tabla `outbox_events` en la misma transacción que el cambio de estado; un job (`@nestjs/schedule`, cada 2 s) lo publica y lo marca enviado.
- **Idempotencia:** cada consumidor guarda los `eventId` procesados; `POST /payments` usa `Idempotency-Key` para que un doble clic no genere dos cobros.
- **Reintentos y DLQ:** *ack* manual; tras 3 fallos el mensaje va a una *dead-letter queue* para revisión.
- **Trazabilidad:** el `correlationId` (id del pedido) viaja en headers HTTP y en cada evento.

## 5. Seguridad

Solo el API Gateway es público; valida el JWT y cada servicio vuelve a validar rol y propiedad del recurso (defensa en profundidad).

### 5.1 Autenticación

- auth-service emite un **access token JWT de 15 min** (firmado con RS256) y un **refresh token de 7 días** guardado con hash y revocable.
- Contraseñas con `bcrypt` (costo 10+); bloqueo temporal tras 5 intentos fallidos.
- Los demás servicios validan el token con la **clave pública**, sin llamar a auth-service (`@nestjs/passport` + `passport-jwt`).

### 5.2 Autorización (RBAC + propiedad)

- Decorador `@Roles('PROVEEDOR')` + `RolesGuard` global en cada servicio.
- Reglas de propiedad: un PROVEEDOR solo edita productos con `storeId` de su tienda; un PRODUCTOR solo ve y paga sus propios pedidos; solo ADMIN consulta todos los pagos.

### 5.3 Perímetro y red

- HTTPS terminado en el gateway; `helmet` y CORS restringido al dominio del front.
- *Rate limiting* con `@nestjs/throttler` (p. ej. 100 req/min por IP, 5/min en `/auth/login` y 10/min en `/payments`).
- Servicios y bases en una red interna de Docker sin puertos expuestos.
- Endpoints `/internal/*` protegidos con un token de servicio (o mTLS en producción) y bloqueados en el gateway.

### 5.4 Datos y cumplimiento

- Validación estricta de entrada: `ValidationPipe` global con `whitelist` y `forbidNonWhitelisted` (evita *mass assignment*); TypeORM con consultas parametrizadas.
- Secretos en variables de entorno (`@nestjs/config`), nunca en el repositorio; en producción, un gestor de secretos.
- **Pagos:** el sistema nunca recibe ni guarda datos de tarjeta, solo tokens (como haría una pasarela real, para no entrar en alcance PCI DSS); el webhook se valida con firma HMAC y se rechaza si la firma o el timestamp no coinciden; tabla de auditoría de cada intento de pago.
- Tratamiento de datos personales conforme a la **Ley 1581 de 2012 (Habeas Data)**: consentimiento explícito al registrarse y mínimo de datos necesarios.
- Logs sin contraseñas, tokens ni documentos completos (enmascarado).

## 6. Stack y estructura del proyecto

Un monorepo de Nest CLI (`nest new mini-croper` + `nest g app <servicio>`) comparte código común en librerías sin acoplar los servicios en tiempo de ejecución.

| Capa | Tecnología |
| --- | --- |
| Framework | NestJS 10+ con TypeScript |
| Persistencia | PostgreSQL 16 + TypeORM (migraciones por servicio) |
| Mensajería | RabbitMQ 3 (`@nestjs/microservices`, `Transport.RMQ`) |
| Seguridad | `@nestjs/passport`, `passport-jwt`, `bcrypt`, `helmet`, `@nestjs/throttler` |
| Validación | `class-validator`, `class-transformer` |
| Documentación | `@nestjs/swagger` (OpenAPI por servicio) |
| Pruebas | Jest + Supertest |
| Contenedores | Docker + docker-compose |

```
mini-croper/
├── apps/
│   ├── api-gateway/
│   ├── auth-service/
│   ├── catalog-service/
│   │   └── src/
│   │       ├── products/      # controller, service, entities, dto
│   │       ├── stores/
│   │       ├── stock/         # consumidores de eventos
│   │       └── main.ts        # HTTP + microservicio RMQ híbrido
│   ├── order-service/
│   ├── payment-service/
│   │   └── src/
│   │       ├── payments/      # controller, service, entities, dto
│   │       ├── simulator/     # reglas por token de prueba y latencia
│   │       └── webhook/       # validación HMAC
│   └── notification-service/
├── libs/
│   ├── common/      # guards (JwtAuthGuard, RolesGuard), decoradores, filtros
│   ├── contracts/   # DTOs de eventos y nombres de colas compartidos
│   └── messaging/   # módulo RabbitMQ, outbox, idempotencia
├── docker-compose.yml
├── .env.example
└── README.md
```

Cada servicio arranca como **aplicación híbrida**: escucha HTTP y, a la vez, consume su cola de RabbitMQ.

```typescript
// apps/catalog-service/src/main.ts
const app = await NestFactory.create(CatalogModule);
app.connectMicroservice<MicroserviceOptions>({
  transport: Transport.RMQ,
  options: { urls: [process.env.RMQ_URL], queue: 'catalog.q', noAck: false, queueOptions: { durable: true } },
});
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
await app.startAllMicroservices();
await app.listen(3002);
```

```typescript
// apps/payment-service/src/simulator/payment-simulator.service.ts
const RULES: Record<string, { status: PaymentStatus; reason?: string }> = {
  tok_test_approved: { status: 'APPROVED' },
  tok_test_declined: { status: 'DECLINED', reason: 'Fondos insuficientes' },
  tok_test_error:    { status: 'ERROR', reason: 'Falla de la pasarela' },
  tok_test_pending:  { status: 'PROCESSING' }, // se resuelve por webhook
};

async process(payment: Payment, token: string) {
  await sleep(1000 + Math.random() * 2000); // latencia simulada
  const rule = RULES[token] ?? { status: 'DECLINED', reason: 'Token inválido' };
  return this.payments.finish(payment.id, rule); // emite payment.approved / payment.declined vía outbox
}
```

## 7. Despliegue, observabilidad y pruebas

Todo el sistema se levanta con `docker compose up --build`: 6 contenedores de servicios, 4 PostgreSQL y 1 RabbitMQ.

```yaml
# docker-compose.yml (extracto)
services:
  rabbitmq:
    image: rabbitmq:3-management
    ports: ["15672:15672"]          # consola de administración
  payment-db:
    image: postgres:16
    environment: { POSTGRES_DB: payment_db, POSTGRES_PASSWORD: ${PAYMENT_DB_PASSWORD} }
  payment-service:
    build: { context: ., args: { APP: payment-service } }
    env_file: .env                  # incluye WEBHOOK_SECRET
    depends_on: [payment-db, rabbitmq]
    # sin "ports": solo accesible desde la red interna
  api-gateway:
    build: { context: ., args: { APP: api-gateway } }
    ports: ["3000:3000"]            # único puerto público
networks:
  default: { name: agro-internal }
```

**Observabilidad**

- Logs JSON estructurados (`nestjs-pino`) con `correlationId` en cada línea.
- `GET /health` por servicio con `@nestjs/terminus` (verifica base de datos y RabbitMQ).
- Siguiente paso: métricas Prometheus (p. ej. tasa de pagos aprobados) y trazas distribuidas con OpenTelemetry.

**Pruebas**

| Tipo | Qué cubre | Herramienta |
| --- | --- | --- |
| Unitarias | Reserva de stock, cálculo del total, reglas del simulador de pagos, validación HMAC | Jest |
| Integración | Controladores + base de datos real por servicio | Jest + Supertest + Testcontainers |
| End-to-end | Saga completa: pago aprobado, rechazado con reintento y pedido vencido | Colección Postman / Newman |

**Entregables del repositorio:** README con este diagrama y pasos para correrlo, `.env.example`, Swagger en `/docs` de cada servicio, colección Postman con los tokens de prueba y datos semilla (tiendas y productos con presentaciones).

## 8. Plan de implementación y mejoras futuras

Se construye en 5 fases; las fases 1 a 3 ya son un mínimo entregable y las 4 y 5 son las que diferencian la solución.

- [ ] **Fase 1 — Base:** monorepo, `libs/common`, docker-compose con PostgreSQL y RabbitMQ.
- [ ] **Fase 2 — Identidad:** auth-service (registro, login, JWT, roles) y API Gateway con validación de token.
- [ ] **Fase 3 — Catálogo y pedidos:** catalog-service con variantes y stock; order-service con carrito y checkout.
- [ ] **Fase 4 — Pagos y saga:** payment-service simulado, eventos, outbox, idempotencia, expiración y compensación de stock.
- [ ] **Fase 5 — Cierre:** notification-service, pruebas, Swagger, README y colección Postman.

**Mejoras futuras** (para mencionar en la sustentación, no para implementar)

| Mejora | Por qué en el negocio agro |
| --- | --- |
| Pasarela real (Wompi, PayU, Mercado Pago) | Reemplazar el simulador sin tocar los demás servicios: solo cambia el adaptador de payment-service |
| credit-service | Financiar compras con crédito agro de aliados financieros, como hace Croper |
| search-service con Elasticsearch | Búsqueda por cultivo, ingrediente activo y ubicación en un catálogo grande |
| quote-service | Productos "precio a cotizar" y compras B2B por volumen |
| logistics-service | Cobertura y costo de envío por municipio ("Enviar a") |
| Kubernetes + CI/CD | Escalado independiente por servicio, por ejemplo catálogo en temporada de siembra |