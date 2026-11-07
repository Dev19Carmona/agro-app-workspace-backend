# Reglas de negocio de Mini-Croper

> **Documento vivo.** Es la fuente de verdad de las reglas de negocio del marketplace agropecuario Mini-Croper (multi-vendedor, con pago virtual simulado). Se edita directamente cuando una regla cambia; no hace falta un spec nuevo.
>
> **Última actualización:** 2026-11-06

## Cómo mantener este archivo

- Cambia la regla aquí en el mismo PR que cambia el código. Si el código y este archivo discrepan, uno de los dos está mal: corrígelo.
- Anota cada cambio relevante en "Historial de cambios" (fecha, qué cambió, por qué).
- Aquí solo van **reglas de negocio** (qué debe pasar), no decisiones de stack ni código. La arquitectura vigente está en `CLAUDE.md` ("Arquitectura").
- `references/LogicaNegocio.md` es el origen histórico y no se edita. `specs/01-reglas-de-negocio.md` es la foto inicial de estas reglas y ya no se mantiene.
- Precedencia: ante conflicto de reglas de negocio manda este archivo; ante conflicto de stack mandan las convenciones de `CLAUDE.md`.

## Roles

| Rol | Permisos de negocio |
| --- | --- |
| `PRODUCTOR` | Busca productos, arma carrito, hace checkout y paga. Solo ve y paga sus propios pedidos. |
| `PROVEEDOR` | Administra su tienda, productos, variantes y stock. Ve los sub-pedidos pagados de su tienda. Solo edita recursos con su `storeId`. |
| `ADMIN` | Gestiona usuarios, categorías y tiendas. Es el único que consulta todos los pagos. |

## Vocabulario de dominio

Los nombres se conservan tal cual deben usarse en el código.

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

## Estados

```text
Pedido: PENDING → AWAITING_PAYMENT → CONFIRMED | CANCELLED
Pago:   PENDING → PROCESSING → APPROVED | DECLINED | ERROR
Método de pago: CARD | PSE | NEQUI
```

## Persistencia

- Los datos viven en **MongoDB**. Cada módulo es dueño de sus colecciones y ningún otro módulo las lee directamente.
- Los cambios que deben ser atómicos (reserva de stock, cambio de estado del pedido junto con su evento del outbox) se hacen dentro de una transacción.

## Catálogo

- Un producto tiene una o más **presentaciones** (variantes), cada una con precio y stock propios (ej. 1 L, 4 L, 20 L; 25 kg, 50 kg).
- Un producto con `requiresQuote = true` tiene "precio a cotizar" y **no entra al checkout**.
- Una variante puede tener `precioOferta`; el precio vigente es el de oferta si existe.
- Stock disponible = `stock` − `stockReservado`.
- Consultar productos, tiendas y ofertas es público. Crear tiendas y productos y modificar stock requiere `PROVEEDOR`, y solo sobre su tienda.

## Pedidos

- El precio **siempre** se toma del catálogo en el checkout, nunca del cliente.
- Un pedido agrupa ítems de varias tiendas y se divide en un `SubOrder` por tienda.
- Un pedido sin pago aprobado a los **15 minutos** de entrar en `AWAITING_PAYMENT` expira y pasa a `CANCELLED`.
- El proveedor solo ve los sub-pedidos de su tienda una vez pagados.

## Pagos

- El monto lo toma `payments` desde `order`, nunca del cliente.
- Solo se paga un pedido en `AWAITING_PAYMENT`.
- Un pedido admite **un único pago aprobado**.
- `POST /payments` exige el header `Idempotency-Key`; un doble clic no genera dos cobros.
- El cliente nunca envía datos reales de tarjeta, solo un token de prueba.
- La simulación tiene latencia de 1 a 3 segundos.
- El webhook se valida con firma HMAC y se rechaza si la firma o el timestamp no coinciden.
- Cada intento de pago queda registrado en `PaymentAttempt` (auditoría).
- Un pago `DECLINED` o `ERROR` deja el pedido en `AWAITING_PAYMENT` y el productor puede reintentar mientras no venza.

### Tokens de prueba del simulador

| Token | Resultado | Motivo |
| --- | --- | --- |
| `tok_test_approved` | `APPROVED` | — |
| `tok_test_declined` | `DECLINED` | Fondos insuficientes |
| `tok_test_error` | `ERROR` | Falla de la pasarela (reintentable) |
| `tok_test_pending` | Queda en `PROCESSING` | Se resuelve después por webhook (simula PSE) |
| Cualquier otro | `DECLINED` | Token inválido |

## Saga de pedido con pago virtual

1. `POST /orders/checkout` guarda el pedido en `PENDING` y emite `order.created`.
2. El catálogo reserva stock por variante de forma transaccional, con una actualización atómica condicional: solo reserva si `stock − stockReservado` alcanza para la cantidad pedida.
   - Alcanza: emite `stock.reserved` y el pedido pasa a `AWAITING_PAYMENT` con vencimiento en 15 min.
   - No alcanza: emite `stock.rejected` y el pedido pasa a `CANCELLED`.
3. El productor paga con `POST /payments`; pagos valida el monto con pedidos y simula la transacción.
   - Aprobado: `payment.approved` → pedido `CONFIRMED` → `order.confirmed`.
   - Rechazado o con error: `payment.declined` → el pedido sigue en `AWAITING_PAYMENT`.
4. Si el pedido vence sin pago aprobado, un job lo pasa a `CANCELLED` → `order.cancelled` → catálogo libera el stock (`stock.released`). Esta es la **compensación**.
5. Notificaciones avisa al productor y a cada tienda del resultado.

## Eventos

Formato común (el `correlationId` es el id del pedido):

```text
{ eventId, type, occurredAt, correlationId, payload }
```

| Evento | Publica | Consume |
| --- | --- | --- |
| `user.registered` | auth | notification |
| `order.created` | order | catalog |
| `stock.reserved` / `stock.rejected` | catalog | order |
| `stock.released` | catalog | order |
| `payment.approved` / `payment.declined` | payment | order, notification |
| `order.confirmed` / `order.cancelled` | order | catalog, notification |

### Garantías de entrega

- **Outbox:** el evento se guarda en la colección `outbox_events` en la misma transacción que el cambio de estado, y un job periódico (cada 2 s) lo publica y lo marca enviado.
- **Idempotencia de consumidores:** cada consumidor guarda los `eventId` procesados.
- **Reintentos y DLQ:** *ack* manual; tras 3 fallos el mensaje va a una *dead-letter queue*.
- **Trazabilidad:** el `correlationId` viaja en headers HTTP y en cada evento.

## Seguridad y permisos

- Solo el monolito `api` es público; valida el JWT en un guard global y cada módulo vuelve a validar rol y propiedad (defensa en profundidad). `notifications` no se expone al público.
- Access token JWT de **15 min** (RS256) y refresh token de **7 días**, guardado con hash y revocable.
- Contraseñas con `bcrypt` (costo 10 o más); bloqueo temporal tras **5 intentos fallidos** de login.
- Los módulos validan el JWT con la clave pública, sin llamar a `auth`; `notifications` solo acepta eventos del monolito.
- RBAC con `@Roles(...)` y `RolesGuard`, más reglas de propiedad: PROVEEDOR solo su tienda, PRODUCTOR solo sus pedidos, solo ADMIN todos los pagos.
- Rate limiting: 100 req/min por IP, 5/min en `/auth/login`, 10/min en `/payments`.
- Endpoints `/internal/*` (p. ej. del servicio `notifications`) protegidos con token de servicio y no expuestos por `api`.
- Validación estricta de entrada que rechace propiedades desconocidas (evita *mass assignment*).
- El sistema nunca recibe ni guarda datos de tarjeta (fuera de alcance PCI DSS).
- Habeas Data (Ley 1581 de 2012): consentimiento explícito al registrarse y mínimo de datos.
- Los logs no incluyen contraseñas, tokens ni documentos completos.

## Fuera de alcance (mejoras futuras)

Pagos reales, crédito, logística, búsqueda avanzada y cotizaciones. Si se abordan, se documentan primero como reglas nuevas aquí.

## Historial de cambios

| Fecha | Cambio | Motivo |
| --- | --- | --- |
| 2026-11-06 | Creación del archivo a partir de `specs/01-reglas-de-negocio.md` (solo reglas; sin plan, criterios ni arquitectura). | Las reglas van a cambiar durante el desarrollo y necesitan un documento vivo en lugar de un spec cerrado. |
| 2026-11-06 | Nueva sección "Persistencia" (MongoDB, colecciones propias por módulo, transacciones). En la saga, la reserva de stock deja de describirse como un bloqueo de filas de base relacional y pasa a ser una actualización atómica condicional. El outbox se guarda en la colección `outbox_events`. | Se eligió MongoDB como base de datos (SPEC 02); las reglas asumían una base relacional. |
