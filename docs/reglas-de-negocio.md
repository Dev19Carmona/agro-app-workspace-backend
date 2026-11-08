# Reglas de negocio de Mini-Croper

> **Documento vivo.** Es la fuente de verdad de las reglas de negocio del marketplace agropecuario Mini-Croper (multi-vendedor, con pago virtual simulado). Se edita directamente cuando una regla cambia; no hace falta un spec nuevo.
>
> **Última actualización:** 2026-11-08

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
| `PROVEEDOR` | Administra su tienda, productos, variantes y stock. Ve los sub-pedidos pagados de su tienda. Solo edita recursos con su `storeId`. No se registra solo: envía una solicitud que un `ADMIN` aprueba o rechaza (ver "Cuentas y acceso"). |
| `ADMIN` | Gestiona usuarios (aprueba o rechaza solicitudes de `PROVEEDOR`, deshabilita y habilita cuentas, cambia roles), categorías y tiendas. Es el único que consulta todos los pagos. |

## Vocabulario de dominio

Los nombres se conservan tal cual deben usarse en el código.

```text
Auth          User(id, email, passwordHash, nombre, documento, rol, status, storeId?, consent)
              RefreshToken(id, userId, familyId, tokenHash, expiresAt)
Catálogo      Store(id, nombre, nit, ownerId, municipio, activa)
              Category(id, nombre, activa)
              Product(id, storeId, categoryId, nombre, marca, fichaTécnica, requiresQuote, activo)
              ProductVariant(id, productId, presentación, unidad, precio, precioOferta?, stock, stockReservado, activo)
              StockReservation(orderId, status, items)
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
Usuario: PENDING_APPROVAL → ACTIVE | REJECTED   (solo PROVEEDOR, al registrarse)
         ACTIVE ⇄ DISABLED                       (solo ADMIN)
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
- Consultar productos, tiendas, ofertas y categorías es público. Crear tiendas y productos y modificar stock requiere `PROVEEDOR`, y solo sobre su tienda. `ADMIN` gestiona categorías y tiendas, pero no productos ni stock.
- **Una tienda por `PROVEEDOR`.** Al crearla, `catalog` emite `store.created` y `auth` guarda el `storeId` en el usuario. El proveedor se autoriza por ser dueño de la tienda (`ownerId`), no por el `storeId` de su token, que solo se actualiza al renovar el refresh token.
- Un `ADMIN` puede **desactivar** una tienda (`activa = false`): sale de la consulta pública y no admite productos nuevos. No se borra ni se reactiva, para no afectar pedidos históricos.
- Productos y variantes tienen `activo` y no se borran: un pedido histórico puede referenciarlos. Lo inactivo no aparece en la consulta pública. Las categorías también tienen `activa`.
- Una variante sin stock disponible se muestra con `disponible = 0`; no se oculta. La carrera entre la consulta y el checkout la cubre `stock.rejected`.
- Los precios son enteros en COP, sin decimales. `precioOferta`, si existe, es menor que `precio`.
- El `PROVEEDOR` fija el stock con un valor absoluto, y no puede dejarlo por debajo de `stockReservado`.
- El nombre de una categoría es único, sin distinguir mayúsculas ni tildes.

## Pedidos

- El precio **siempre** se toma del catálogo en el checkout, nunca del cliente.
- Un pedido agrupa ítems de varias tiendas y se divide en un `SubOrder` por tienda.
- Un pedido sin pago aprobado a los **15 minutos** de entrar en `AWAITING_PAYMENT` expira y pasa a `CANCELLED`.
- El proveedor solo ve los sub-pedidos de su tienda una vez pagados (pedido `CONFIRMED`). Ve el sub-pedido con sus ítems, el `orderId`, el estado y la fecha, sin `buyerId`, sin el `total` ni las demás tiendas. Su tienda sale del `storeId` de su token; sin ese dato el listado sale vacío y el detalle da `404`.
- El `PRODUCTOR` tiene **un carrito** (sin vencimiento) con máximo **50 líneas** y `cantidad` entera de 1 a 1000 por línea. El carrito solo guarda la variante y la cantidad; el precio, el nombre y la disponibilidad se leen del catálogo cada vez. No admite variantes inexistentes ni no aptas (inactivas, de tienda desactivada o con `requiresQuote`).
- `POST /orders/checkout` exige el header `Idempotency-Key` (de 8 a 100 caracteres). Repetir la misma clave devuelve el mismo pedido y no crea otro `order.created`. El checkout no valida stock: lo hace el catálogo al recibir `order.created`.
- El pedido guarda un **snapshot** de cada ítem (nombre, presentación, unidad y precio), que no cambia aunque el catálogo cambie después.
- Un pedido `PENDING` al que el catálogo no responde (`stock.reserved` o `stock.rejected`) en **5 minutos** pasa a `CANCELLED` por un job.
- **Pago tardío:** un `payment.approved` confirma el pedido mientras siga en `AWAITING_PAYMENT`, aunque su vencimiento ya haya pasado. Gana quien cambie primero el estado: el job de expiración solo cancela con una actualización condicional sobre el estado. Un `payment.approved` sobre un pedido en cualquier otro estado se ignora (el pedido no se reabre; no hay reembolsos) y queda en el log.
- **Reserva tardía:** si el catálogo responde `stock.reserved` cuando el pedido ya está `CANCELLED`, `order` vuelve a emitir `order.cancelled` (con otro `eventId` y `motivo: LATE_RESERVATION`) para que el catálogo libere esa reserva.
- `CONFIRMED` y `CANCELLED` son estados finales. No hay cancelación manual de pedidos, ni por el `PRODUCTOR` ni por el `ADMIN`.
- El `ADMIN` ve todos los pedidos en solo lectura, con filtros por estado y comprador.

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
   - No alcanza: emite `stock.rejected` y el pedido pasa a `CANCELLED` (`STOCK_REJECTED`).
   - Si el catálogo no responde en 5 minutos, el pedido pasa a `CANCELLED` (`STOCK_TIMEOUT`).
3. El productor paga con `POST /payments`; pagos valida el monto con pedidos y simula la transacción.
   - Aprobado: `payment.approved` → pedido `CONFIRMED` → `order.confirmed` (también si el pago llega después del vencimiento, mientras el pedido siga en `AWAITING_PAYMENT`).
   - Rechazado o con error: `payment.declined` → el pedido sigue en `AWAITING_PAYMENT`.
4. Si el pedido vence sin pago aprobado, un job lo pasa a `CANCELLED` → `order.cancelled` → catálogo libera el stock (`stock.released`). Esta es la **compensación**. `order` consume `stock.released` solo para marcarlo procesado y dejarlo en el log: no cambia ningún estado.
5. Notificaciones avisa al productor y a cada tienda del resultado.

### Reservas de stock

El catálogo guarda una `StockReservation` por pedido (`orderId` único) con estado `RESERVED`, `REJECTED`, `CONFIRMED` o `RELEASED`. Así libera solo lo que realmente reservó y procesa cada evento una sola vez.

- La reserva es todo o nada: si algún ítem no alcanza, no queda ninguna reserva parcial. El motivo del rechazo es `INSUFFICIENT_STOCK`, o `VARIANT_UNAVAILABLE` si la variante no existe o no es apta (inactiva, de un producto inactivo o con `requiresQuote`, o de una tienda desactivada).
- `order.confirmed`: si la reserva está `RESERVED`, resta la cantidad de `stock` y de `stockReservado` y la pasa a `CONFIRMED`.
- `order.cancelled`: si la reserva está `RESERVED`, resta la cantidad de `stockReservado`, la pasa a `RELEASED` y emite `stock.released`. Si está `REJECTED`, `CONFIRMED`, `RELEASED` o no existe, no libera nada ni emite. Un pedido cancelado por `stock.rejected` nunca libera stock.
- Un `order.created` repetido (mismo `eventId`) no reserva dos veces.

## Eventos

Formato común (el `correlationId` es el id del pedido):

```text
{ eventId, type, occurredAt, correlationId, payload }
```

| Evento | Publica | Consume |
| --- | --- | --- |
| `user.registered` | auth | notification |
| `provider.approved` / `provider.rejected` | auth | notification |
| `store.created` | catalog | auth |
| `order.created` | order | catalog |
| `stock.reserved` / `stock.rejected` | catalog | order |
| `stock.released` | catalog | order (solo lo registra) |
| `payment.approved` / `payment.declined` | payment | order, notification |
| `order.confirmed` / `order.cancelled` | order | catalog, notification |

### Garantías de entrega

- **Outbox:** el evento se guarda en la colección `outbox_events` en la misma transacción que el cambio de estado, y un job periódico (cada 2 s) lo publica y lo marca enviado. `order` nunca emite `order.*` directamente: el outbox es su único camino de emisión.
- **Estados del outbox:** `PENDING`, `PUBLISHED` y `FAILED`. Un fallo de publicación se reintenta con espera creciente (2 s × 2^intento, máximo 60 s) y tras **5 intentos** el evento queda en `FAILED` para revisión manual. Es entrega al menos una vez: si el proceso cae tras publicar y antes de marcar, el evento se publica de nuevo.
- **Idempotencia de consumidores:** cada consumidor guarda los `eventId` procesados en su propia colección (`processed_events` en `catalog`, `order_processed_events` en `order`). Marcar el evento y aplicar su efecto ocurre en la misma transacción.
- **Reintentos y DLQ:** *ack* manual; tras 3 fallos el mensaje va a una *dead-letter queue*. Depende del transporte hacia `notifications`, que aún no está decidido, así que todavía no se implementa. Mientras tanto rige el límite de 5 intentos del outbox.
- **Trazabilidad:** el `correlationId` viaja en headers HTTP y en cada evento.

## Cuentas y acceso

- El registro es público y el solicitante elige `PRODUCTOR` o `PROVEEDOR`; **nunca `ADMIN`**. Exige aceptar el tratamiento de datos y se guarda el consentimiento con su fecha.
- Un `PRODUCTOR` queda `ACTIVE` al registrarse.
- **Un `PROVEEDOR` no se registra solo.** Queda `PENDING_APPROVAL` y no puede iniciar sesión hasta que un `ADMIN` apruebe su solicitud (`ACTIVE`) o la rechace (`REJECTED`, con motivo opcional). Solo se aprueba o rechaza a un `PROVEEDOR` pendiente.
- Un `REJECTED` no puede volver a registrarse con ese email; un `ADMIN` puede revertirlo a mano.
- Un `ADMIN` puede deshabilitar una cuenta activa (`DISABLED`) y volver a habilitarla. Una cuenta deshabilitada no inicia sesión.
- El registro público no crea `ADMIN`: el primero sale del script `seed:admin` y los siguientes los promueve un `ADMIN`. Un `ADMIN` no puede deshabilitarse ni cambiarse el rol a sí mismo, para no quedar fuera del sistema.
- Cambiar el rol solo aplica a cuentas `ACTIVE` o `DISABLED`; las pendientes y rechazadas siguen el flujo de aprobación.
- Deshabilitar una cuenta o cambiarle el rol cierra todas sus sesiones. El access token ya emitido sigue valiendo hasta 15 min (ventana aceptada).
- Cambiar la contraseña exige la actual y cierra todas las sesiones del usuario.
- El email es único y no distingue mayúsculas.

## Seguridad y permisos

- Solo el monolito `api` es público; valida el JWT en un guard global y cada módulo vuelve a validar rol y propiedad (defensa en profundidad). `notifications` no se expone al público.
- Access token JWT de **15 min** (RS256), sin email ni documento en sus datos. Refresh token opaco de **7 días**, guardado con hash, revocable y **rotado en cada uso**: reutilizar uno ya usado se toma como robo y revoca toda la sesión.
- Contraseñas con `bcrypt` (costo **12**). Política: mínimo 10 caracteres y máximo 72 bytes, con mayúscula, minúscula y número, y sin contener el email.
- Tras **5 intentos fallidos** de login la cuenta se bloquea **15 minutos**; al vencer, el contador vuelve a 0. Email inexistente, contraseña incorrecta y cuenta bloqueada responden igual (`401`), para no revelar qué cuentas existen. El estado de la cuenta (`403`: pendiente, rechazada o deshabilitada) solo se revela con la contraseña correcta.
- Los módulos validan el JWT con la clave pública, sin llamar a `auth`; `notifications` solo acepta eventos del monolito.
- RBAC con `@Roles(...)` y `RolesGuard`, más reglas de propiedad: PROVEEDOR solo su tienda, PRODUCTOR solo sus pedidos, solo ADMIN todos los pagos.
- Rate limiting por IP: 100 req/min en general; 5/min en `/auth/login`, `/auth/register` y `/auth/change-password`; 10/min en `/auth/refresh` y en `/payments`.
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
| 2026-11-07 | Regla nueva: un `PROVEEDOR` no se registra solo, queda `PENDING_APPROVAL` y un `ADMIN` aprueba o rechaza su solicitud. Nuevos estados del usuario (`ACTIVE`, `PENDING_APPROVAL`, `REJECTED`, `DISABLED`) y sección "Cuentas y acceso". Se concretan: política de contraseña, `bcrypt` con costo 12, bloqueo de 15 min tras 5 fallos, rotación del refresh token con revocación de la sesión ante reuso y límites de peticiones por endpoint de `auth`. Nuevos eventos `provider.approved` y `provider.rejected`. | Implementación del módulo `auth` (SPEC 03). La aprobación de proveedores no estaba en las reglas originales y el resto afinaba reglas que solo daban un mínimo. |
| 2026-11-08 | Reglas del catálogo: una tienda por `PROVEEDOR` con `storeId` asignado por el evento `store.created`; tienda desactivable por `ADMIN`; `activo` en producto, variante y categoría (sin `DELETE`); consulta pública sin lo inactivo y variantes sin stock visibles con `disponible = 0`; precios enteros en COP; stock manual absoluto sin bajar de `stockReservado`. Nueva subsección "Reservas de stock" con `StockReservation` y el efecto de `order.confirmed` y `order.cancelled` sobre el stock (un pedido cancelado por `stock.rejected` no libera nada). Nuevo evento `store.created`. | Implementación del módulo `catalog` (SPEC 06). Las reglas no decían qué libera `order.cancelled` tras un `stock.rejected` ni qué hace `order.confirmed` en el catálogo. |
| 2026-11-08 | Reglas de pedidos: carrito del `PRODUCTOR` (uno por usuario, máximo 50 líneas, cantidad de 1 a 1000, solo la variante y la cantidad); `Idempotency-Key` en el checkout; snapshot del ítem; vista del `PROVEEDOR` sin `buyerId` ni `total` y autorizada por el `storeId` del token; `ADMIN` solo lectura; sin cancelación manual. Saga: un `PENDING` sin respuesta del catálogo en 5 min se cancela (`STOCK_TIMEOUT`); **pago tardío** (`payment.approved` confirma mientras el estado sea `AWAITING_PAYMENT`, aunque haya vencido); **reserva tardía** (`stock.reserved` sobre un pedido `CANCELLED` re-emite `order.cancelled` con `LATE_RESERVATION`); `stock.released` solo se registra en `order`. Garantías de entrega: estados del outbox (`PENDING`, `PUBLISHED`, `FAILED`), 5 intentos con espera creciente, colección de idempotencia propia de cada módulo; la DLQ de 3 fallos depende del transporte y no se implementa todavía. | Implementación del módulo `order` (SPEC 07). Las reglas no decían qué hacer con un pago o una reserva que llegan después de cancelar el pedido, para qué consume `order` el evento `stock.released`, ni qué ocurre si el catálogo nunca responde; y la DLQ presupone un transporte que aún no existe. |
