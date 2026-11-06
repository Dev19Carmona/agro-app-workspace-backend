# SPEC 01 — Reglas de negocio de Mini-Croper

> **Status:** Aprobado
> **Depends on:** Ninguna
> **Date:** 2026-11-06
> **Objective:** Dejar consolidadas en el repositorio las reglas de negocio del marketplace agropecuario Mini-Croper (dominio, saga, seguridad y arquitectura objetivo) como contexto fijo para futuros specs y para el agente.

## Por qué existe este spec

El documento fuente `references/LogicaNegocio.md` mezcla reglas de negocio, decisiones de stack y código de ejemplo, y el autor avisó de que no es la versión final. Este spec separa lo que es **regla de negocio** (estable) de lo que es **decisión técnica** (cambiable), y fija las reglas en un lugar que `CLAUDE.md` referencia para que siempre se carguen como contexto.

`references/LogicaNegocio.md` se conserva sin modificar como fuente de origen de este spec. No es la versión definitiva y no debe editarse para reflejar cambios de negocio: esos cambios se hacen en este spec.

Este spec no construye funcionalidad. Los specs de implementación posteriores (auth, catálogo, pedidos, pagos, notificaciones) dependerán de este.

## Alcance

**Dentro:**

- Definir las reglas de dominio: roles, entidades, estados de pedido y de pago, precios, stock, expiración y tokens de prueba de pago.
- Definir la saga de pedido con pago virtual y el catálogo de eventos.
- Definir las reglas de seguridad y permisos.
- Registrar la arquitectura de microservicios como **arquitectura objetivo sujeta a cambio**.
- Añadir en `CLAUDE.md` una sección que apunte a este spec y fije su precedencia.
- Crear `specs/.spec-config.yml` con la configuración por defecto.

**Fuera de alcance (para specs futuros):**

- Cualquier código: servicios, entidades TypeORM, controladores, migraciones, docker-compose.
- Decidir de forma definitiva monolito modular vs. microservicios.
- Pagos reales, crédito, logística, búsqueda avanzada, cotizaciones (ver "Mejoras futuras").
- Cambiar el stack del repo (NestJS 12, Vitest, oxlint, ESM).
- Colección Postman, datos semilla y README de entrega.

## Modelo de datos

Este spec no crea estructuras en código. Fija el vocabulario de dominio que los specs futuros deben respetar. Los nombres se conservan en el idioma del documento fuente.

### Roles

| Rol | Permisos de negocio |
| --- | --- |
| `PRODUCTOR` | Busca productos, arma carrito, hace checkout y paga. Solo ve y paga sus propios pedidos. |
| `PROVEEDOR` | Administra su tienda, productos, variantes y stock. Ve los sub-pedidos pagados de su tienda. Solo edita recursos con su `storeId`. |
| `ADMIN` | Gestiona usuarios, categorías y tiendas. Es el único que consulta todos los pagos. |

### Entidades por dominio

```text
Auth          User(id, email, passwordHash, nombre, documento, rol, storeId?)
              RefreshToken
Catálogo      Store(id, nombre, nit, ownerId, municipio)
              Category
              Product(id, storeId, categoryId, nombre, marca, fichaTécnica, requiresQuote)
              ProductVariant(id, productId, presentación, unidad, precio, precioOferta?, stock, stockReservado)
Pedidos       Cart, CartItem
              Order(id, buyerId, total, status, expiresAt)
              SubOrder (una por tienda), OrderItem
              OutboxEvent
Pagos         Payment(id, orderId, buyerId, monto, moneda=COP, método, status, referencia, motivoRechazo, idempotencyKey)
              PaymentAttempt (historial de intentos)
Notificación  Sin entidades; solo registra o envía avisos.
```

### Estados

```text
Pedido: PENDING → AWAITING_PAYMENT → CONFIRMED | CANCELLED
Pago:   PENDING → PROCESSING → APPROVED | DECLINED | ERROR
Método de pago: CARD | PSE | NEQUI
```

### Tokens de prueba del simulador de pagos

| Token | Resultado | Motivo |
| --- | --- | --- |
| `tok_test_approved` | `APPROVED` | — |
| `tok_test_declined` | `DECLINED` | Fondos insuficientes |
| `tok_test_error` | `ERROR` | Falla de la pasarela (reintentable) |
| `tok_test_pending` | Queda en `PROCESSING` | Se resuelve después por webhook (simula PSE) |
| Cualquier otro | `DECLINED` | Token inválido |

### Formato común de evento

```text
{ eventId, type, occurredAt, correlationId, payload }
```

El `correlationId` es el id del pedido.

## Reglas de negocio

### Catálogo

- Un producto tiene una o más **presentaciones** (variantes), cada una con precio y stock propios (ej. 1 L, 4 L, 20 L; 25 kg, 50 kg).
- Un producto con `requiresQuote = true` tiene "precio a cotizar" y **no entra al checkout**.
- Una variante puede tener `precioOferta`; el precio vigente es el de oferta si existe.
- Stock disponible = `stock` − `stockReservado`.
- Consultar productos, tiendas y ofertas es público. Crear tiendas y productos y modificar stock requiere `PROVEEDOR`, y solo sobre su tienda.

### Pedidos

- El precio **siempre** se toma del catálogo en el checkout, nunca del cliente.
- Un pedido agrupa ítems de varias tiendas y se divide en un `SubOrder` por tienda.
- Un pedido sin pago aprobado a los **15 minutos** de entrar en `AWAITING_PAYMENT` expira y pasa a `CANCELLED`.
- El proveedor solo ve los sub-pedidos de su tienda una vez pagados.

### Pagos

- El monto lo toma `payment` desde `order`, nunca del cliente.
- Solo se paga un pedido en `AWAITING_PAYMENT`.
- Un pedido admite **un único pago aprobado**.
- `POST /payments` exige el header `Idempotency-Key`; un doble clic no genera dos cobros.
- El cliente nunca envía datos reales de tarjeta, solo un token de prueba.
- La simulación tiene latencia de 1 a 3 segundos.
- El webhook se valida con firma HMAC y se rechaza si la firma o el timestamp no coinciden.
- Cada intento de pago queda registrado en `PaymentAttempt` (auditoría).
- Un pago `DECLINED` o `ERROR` deja el pedido en `AWAITING_PAYMENT` y el productor puede reintentar mientras no venza.

### Saga de pedido con pago virtual

1. `POST /orders/checkout` guarda el pedido en `PENDING` y emite `order.created`.
2. El catálogo reserva stock por variante de forma transaccional (`SELECT … FOR UPDATE`).
   - Alcanza: emite `stock.reserved` y el pedido pasa a `AWAITING_PAYMENT` con vencimiento en 15 min.
   - No alcanza: emite `stock.rejected` y el pedido pasa a `CANCELLED`.
3. El productor paga con `POST /payments`; pagos valida el monto con pedidos y simula la transacción.
   - Aprobado: `payment.approved` → pedido `CONFIRMED` → `order.confirmed`.
   - Rechazado o con error: `payment.declined` → el pedido sigue en `AWAITING_PAYMENT`.
4. Si el pedido vence sin pago aprobado, un job lo pasa a `CANCELLED` → `order.cancelled` → catálogo libera el stock (`stock.released`). Esta es la **compensación**.
5. Notificaciones avisa al productor y a cada tienda del resultado.

### Catálogo de eventos

| Evento | Publica | Consume |
| --- | --- | --- |
| `user.registered` | auth | notification |
| `order.created` | order | catalog |
| `stock.reserved` / `stock.rejected` | catalog | order |
| `stock.released` | catalog | order |
| `payment.approved` / `payment.declined` | payment | order, notification |
| `order.confirmed` / `order.cancelled` | order | catalog, notification |

### Garantías de entrega

- **Outbox:** el evento se guarda en `outbox_events` en la misma transacción que el cambio de estado, y un job periódico (cada 2 s) lo publica y lo marca enviado.
- **Idempotencia de consumidores:** cada consumidor guarda los `eventId` procesados.
- **Reintentos y DLQ:** *ack* manual; tras 3 fallos el mensaje va a una *dead-letter queue*.
- **Trazabilidad:** el `correlationId` viaja en headers HTTP y en cada evento.

### Seguridad y permisos

- Solo el API Gateway es público; valida el JWT y cada servicio vuelve a validar rol y propiedad (defensa en profundidad).
- Access token JWT de **15 min** (RS256) y refresh token de **7 días**, guardado con hash y revocable.
- Contraseñas con `bcrypt` (costo 10 o más); bloqueo temporal tras **5 intentos fallidos** de login.
- Los servicios validan el JWT con la clave pública, sin llamar a `auth`.
- RBAC con `@Roles(...)` y `RolesGuard`, más reglas de propiedad: PROVEEDOR solo su tienda, PRODUCTOR solo sus pedidos, solo ADMIN todos los pagos.
- Rate limiting: 100 req/min por IP, 5/min en `/auth/login`, 10/min en `/payments`.
- Endpoints `/internal/*` protegidos con token de servicio y bloqueados en el gateway.
- Validación estricta de entrada que rechace propiedades desconocidas (evita *mass assignment*).
- El sistema nunca recibe ni guarda datos de tarjeta (fuera de alcance PCI DSS).
- Habeas Data (Ley 1581 de 2012): consentimiento explícito al registrarse y mínimo de datos.
- Los logs no incluyen contraseñas, tokens ni documentos completos.

## Arquitectura objetivo (sujeta a cambio)

Esta sección describe el destino planteado en el documento fuente. **No es una decisión cerrada**: las reglas de arriba están escritas por dominio y no dependen de ella.

| Servicio | Puerto | Base de datos | Responsabilidad |
| --- | --- | --- | --- |
| api-gateway | 3000 | — | Entrada única, valida JWT, rate limiting, enruta |
| auth-service | 3001 | `auth_db` | Registro, login, JWT, roles |
| catalog-service | 3002 | `catalog_db` | Tiendas, categorías, productos, variantes, stock, ofertas |
| order-service | 3003 | `order_db` | Carrito, checkout, pedidos, sub-pedidos |
| payment-service | 3004 | `payment_db` | Pasarela simulada y registro de pagos |
| notification-service | 3005 | — | Consume eventos y envía avisos simulados |

- Cada servicio es dueño de sus datos (*database per service*); se comunican por HTTP o eventos.
- Broker: RabbitMQ con exchange *topic* `agro.events` y una cola por consumidor.
- Lecturas síncronas: `order` pide precios a `catalog`; `payment` pide monto y estado a `order`.
- Prefijo de API: `/api/v1`.
- Entregables mencionados: Swagger por servicio, `GET /health`, logs JSON con `correlationId`.

## Plan de implementación

1. Crear `specs/01-reglas-de-negocio.md` (este archivo) y `specs/.spec-config.yml`.
2. Añadir a `CLAUDE.md` una sección "Reglas de negocio" que apunte a `specs/01-reglas-de-negocio.md`, indique que `references/LogicaNegocio.md` es el origen no definitivo y fije la precedencia: ante conflicto de **stack**, mandan las convenciones del repo; ante conflicto de **reglas de negocio**, manda este spec.
3. Marcar en el spec que `references/LogicaNegocio.md` se conserva sin modificar como fuente de origen.
4. Revisar el spec y cambiar su estado a `Aprobado`.

## Criterios de aceptación

- [ ] Existe `specs/01-reglas-de-negocio.md` con estado `Borrador` o `Aprobado`.
- [ ] Existe `specs/.spec-config.yml` con `AutoCreateBranch: true`.
- [ ] `CLAUDE.md` contiene una sección "Reglas de negocio" que enlaza a `specs/01-reglas-de-negocio.md`.
- [ ] `CLAUDE.md` indica que el stack del repo prevalece sobre el del markdown fuente.
- [ ] El spec documenta los 3 roles, los 4 estados de pedido, los 5 estados de pago y los 4 tokens de prueba.
- [ ] El spec documenta los 5 pasos de la saga y los 8 tipos de evento del catálogo.
- [ ] El spec marca la arquitectura de microservicios como "sujeta a cambio".
- [ ] `references/LogicaNegocio.md` no fue modificado.
- [ ] No se modificó ningún archivo bajo `src/` ni `test/`.
- [ ] `npm run build` y `npm run lint` terminan sin errores.

## Decisiones

- **Sí:** un spec + referencia en `CLAUDE.md`. Carga siempre como contexto y es poco mantenimiento.
- **No:** carpeta `docs/` por dominio. Es más granular, pero el documento fuente aún va a cambiar y duplicaría el mantenimiento.
- **Sí:** las convenciones del repo prevalecen sobre el stack del markdown (Vitest, NestJS 12, oxlint, ESM). Las reglas de negocio no dependen del stack.
- **No:** adoptar Jest, NestJS 10 ni `class-validator` como obligatorios. Quedan descartados por el punto anterior.
- **Sí:** arquitectura de microservicios como objetivo y no como decisión cerrada. El repo hoy es una sola app Nest y el autor indicó que el documento puede cambiar.
- **No:** monolito modular como decisión ahora. Se decidirá en un spec propio cuando se implemente el primer dominio.
- **Sí:** reglas escritas por dominio y no por servicio. Así sobreviven a un cambio de arquitectura.
- **Sí:** conservar `references/LogicaNegocio.md` intacto como fuente histórica.
- **Sí:** el código de ejemplo del documento fuente (`main.ts`, simulador) no se copia; solo se conserva su comportamiento como regla.

## Riesgos

| Riesgo | Mitigación |
| --- | --- |
| El documento fuente cambia y el spec queda desactualizado | El spec manda en negocio; cualquier cambio se hace editando el spec o con un spec nuevo que lo marque `Obsoleto`. |
| Un spec futuro asume microservicios por leer la sección de arquitectura | La sección está rotulada "sujeta a cambio" y las reglas no dependen de ella. |
| Contradicciones entre el documento fuente y `CLAUDE.md` (stack) | La precedencia queda escrita en `CLAUDE.md`. |

## Qué **no** está en este spec

- Código de ningún servicio, entidad, endpoint o migración.
- La decisión definitiva de arquitectura (microservicios vs. monolito modular).
- Pasarela real, `credit-service`, `search-service`, `quote-service`, `logistics-service`, Kubernetes y CI/CD.
- Docker, docker-compose, Swagger, Postman y datos semilla.
- Cambios de stack o de herramientas del repo.

Cada uno de estos, si se aborda, va en su propio spec.
