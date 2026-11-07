# SPEC 05 — Cascada de agentes que redactan los specs de catalog, order y payments

> **Status:** Aprobado
> **Depends on:** SPEC 01, SPEC 03, SPEC 04
> **Date:** 2026-11-07
> **Objective:** Crear tres subagentes del proyecto (`spec-catalog`, `spec-order`, `spec-payments`) que, ejecutados en cascada y con aprobación humana entre cada uno, redacten los specs 06, 07 y 08 de los módulos `catalog`, `order` y `payments` a partir de `docs/reglas-de-negocio.md`.

## Por qué existe este spec

`catalog`, `order` y `payments` son esqueletos vacíos (SPEC 04) y las reglas de negocio ya describen su comportamiento, pero cada módulo es demasiado grande para un solo spec y depende del anterior: `order` necesita la reserva de stock de `catalog`, y `payments` necesita el monto y el estado del pedido de `order`.

Redactarlos uno tras otro a mano obliga a releer las mismas reglas tres veces. Este spec convierte esa tarea en tres agentes con contexto propio de dominio que se ejecutan en orden de dependencia. Cada agente lee el spec **aprobado** del anterior, de modo que los contratos entre módulos (eventos, interfaces públicas) quedan alineados y no se contradicen.

Este spec **no escribe código de dominio ni los specs 06–08 a mano**: define los agentes, el protocolo de la cascada y el formato de lo que deben producir. Los specs 06–08 los redactan los agentes al ejecutarlo.

## Alcance

**Dentro:**

- **Tres subagentes del proyecto** en `.claude/agents/`, versionados en git:
  - `spec-catalog.md` → redacta `specs/06-modulo-catalog.md`.
  - `spec-order.md` → redacta `specs/07-modulo-order.md`.
  - `spec-payments.md` → redacta `specs/08-modulo-payments.md`.
- **Protocolo de la cascada**, ejecutado por la sesión principal (los subagentes no lanzan otros subagentes):
  1. Lanzar `spec-catalog`; revisar `specs/06`; el usuario lo marca `Aprobado`.
  2. Lanzar `spec-order`; revisar `specs/07`; el usuario lo marca `Aprobado`.
  3. Lanzar `spec-payments`; revisar `specs/08`; queda en `Borrador` para su revisión.
  - Un agente no arranca si el spec del que depende no está en estado `Aprobado`.
- **Contenido común de los tres agentes:**
  - Leen `CLAUDE.md`, `docs/reglas-de-negocio.md`, los specs 03 y 04 y el spec aprobado del módulo anterior.
  - Escriben el spec con las secciones de la plantilla de `/spec` (cabecera, alcance, modelo de datos, plan de implementación, criterios de aceptación, decisiones, riesgos, «Qué no está»), en español y con los mismos encabezados que los specs 03 y 04.
  - Respetan la estructura de módulo de `CLAUDE.md` («Estructura de un módulo») y la regla de `index.ts` como API pública.
  - Marcan el spec como `Borrador`, con la fecha que les pasa la sesión principal.
  - Si algo no se puede decidir con las reglas de negocio, **no inventan**: devuelven la lista de preguntas a la sesión principal, que las plantea al usuario con `AskUserQuestion`, y reintentan con las respuestas.
- **Herramientas de cada agente:** `Read`, `Glob`, `Grep` y `Write` (solo para su spec). Sin `Bash`, `Edit` ni acceso a `apps/`, `libs/` o `docs/` para escritura.
- **Decisiones de arquitectura fijadas para los tres specs** (los agentes las heredan, no las reabren):
  - Comunicación entre módulos con eventos en memoria (`@nestjs/event-emitter`, como `auth`).
  - Outbox transaccional en la colección `outbox_events`, propiedad de `order`, publicado por un job cada 2 s también en memoria.
  - Idempotencia de consumidores guardando los `eventId` procesados.
  - El transporte hacia `notifications` (RabbitMQ u otro) **no** se decide ni se implementa.

**Fuera de alcance (para specs futuros):**

- Implementar `catalog`, `order` o `payments`: cada spec 06–08 se implementa después con `/spec-impl`.
- Transporte de eventos hacia `notifications` y consumo de eventos allí.
- Cambios en `docs/reglas-de-negocio.md`: si un agente detecta una regla ambigua o contradictoria, lo reporta; la actualización del documento vivo se hace en el spec de implementación correspondiente.
- Un agente orquestador o un comando `/cascada` que automatice la secuencia: la sesión principal la ejecuta a mano siguiendo el protocolo.
- Agentes para `auth` o `notifications`.
- Reglas de lint, CI o hooks que verifiquen la cascada.

## Modelo de datos

Este spec no introduce datos de dominio, colecciones ni variables de entorno. Introduce tres archivos de agente y reserva tres números de spec.

```text
.claude/agents/
  spec-catalog.md     # → specs/06-modulo-catalog.md
  spec-order.md       # → specs/07-modulo-order.md
  spec-payments.md    # → specs/08-modulo-payments.md
specs/
  06-modulo-catalog.md    # lo crea spec-catalog
  07-modulo-order.md      # lo crea spec-order
  08-modulo-payments.md   # lo crea spec-payments
```

Frontmatter de cada agente:

```yaml
---
name: spec-catalog
description: Redacta specs/06-modulo-catalog.md a partir de las reglas de negocio. Solo escribe el spec; no implementa código.
tools: Read, Glob, Grep, Write
---
```

Entradas y salidas por agente:

| Agente | Lee (además de `CLAUDE.md` y las reglas) | Escribe | Contrato que debe dejar definido |
| --- | --- | --- | --- |
| `spec-catalog` | specs 03 y 04 | `specs/06-modulo-catalog.md` | `Store`, `Category`, `Product`, `ProductVariant`; endpoints públicos y de PROVEEDOR/ADMIN; asignación de `storeId`; escucha de `order.created`, `order.cancelled` y `order.confirmed`; emisión de `stock.reserved`, `stock.rejected` y `stock.released`; API pública de `index.ts` que `order` consume |
| `spec-order` | specs 03, 04 y 06 | `specs/07-modulo-order.md` | `Cart`, `CartItem`, `Order`, `SubOrder`, `OrderItem`, `OutboxEvent`; checkout con precio tomado del catálogo; saga; expiración a 15 min; vista de sub-pedidos pagados del proveedor; emisión de `order.created`, `order.confirmed`, `order.cancelled`; API pública de `index.ts` que `payments` consume |
| `spec-payments` | specs 03, 04, 06 y 07 | `specs/08-modulo-payments.md` | `Payment`, `PaymentAttempt`; `POST /payments` con `Idempotency-Key`; simulador y tokens de prueba; webhook con HMAC y timestamp; rate limit de 10/min; consulta de pagos solo ADMIN; emisión de `payment.approved` y `payment.declined` |

Convenciones para los specs que redacten los agentes:

- Numeración fija: 06 `catalog`, 07 `order`, 08 `payments`.
- Cabecera con `**Depends on:**` apuntando a specs que existan en `specs/` (06 depende de 03 y 04; 07 de 06; 08 de 07).
- Nombres de entidades y eventos tal cual aparecen en el vocabulario de `docs/reglas-de-negocio.md`.
- Cada spec de módulo debe caber en su propio objetivo de una sola frase; si no cabe, el agente propone dividirlo en lugar de escribirlo.
- Los pasos del plan dejan el sistema compilando y con `npm test` en verde, como en los specs 03 y 04.

## Plan de implementación

Cada paso deja el repositorio en estado coherente y es commiteable por separado.

1. **Agente `spec-catalog`.** Crear `.claude/agents/spec-catalog.md` con el frontmatter de arriba y un prompt que indique: archivos a leer, plantilla y encabezados a seguir, contrato que debe definir (tabla del modelo de datos), decisiones heredadas, regla de preguntar en lugar de inventar y prohibición de escribir fuera de `specs/06-modulo-catalog.md`.
2. **Agente `spec-order`.** Crear `.claude/agents/spec-order.md` con la misma forma. Añade la precondición: leer `specs/06-modulo-catalog.md` y abortar con aviso si su estado no es `Aprobado`.
3. **Agente `spec-payments`.** Crear `.claude/agents/spec-payments.md` con la misma forma y la precondición sobre `specs/07-modulo-order.md`.
4. **Verificar que los tres agentes se reconocen.** Comprobar que Claude Code lista `spec-catalog`, `spec-order` y `spec-payments` entre los agentes disponibles tras recargar la sesión.
5. **Ejecutar `spec-catalog`.** Lanzarlo desde la sesión principal con la fecha de hoy. Resolver con el usuario las preguntas que devuelva. Revisar `specs/06-modulo-catalog.md`. **Parar y esperar** a que el usuario lo marque `Aprobado`.
6. **Ejecutar `spec-order`.** Solo con `specs/06` aprobado. Mismo ciclo de preguntas y revisión sobre `specs/07-modulo-order.md`. **Parar y esperar** su aprobación.
7. **Ejecutar `spec-payments`.** Solo con `specs/07` aprobado. Mismo ciclo sobre `specs/08-modulo-payments.md`. Dejarlo en `Borrador` y detenerse.

## Criterios de aceptación

- [ ] Existen `.claude/agents/spec-catalog.md`, `spec-order.md` y `spec-payments.md`, cada uno con frontmatter válido (`name`, `description`, `tools`).
- [ ] El campo `tools` de cada agente es exactamente `Read, Glob, Grep, Write`.
- [ ] Cada agente nombra en su prompt los archivos que debe leer: `CLAUDE.md`, `docs/reglas-de-negocio.md`, `specs/03-modulo-auth.md`, `specs/04-estructura-de-modulos.md` y, según el caso, el spec anterior de la cascada.
- [ ] `spec-order` y `spec-payments` incluyen la precondición de abortar si el spec anterior no está `Aprobado`.
- [ ] Cada agente prohíbe escribir un archivo distinto de su spec y prohíbe modificar `docs/reglas-de-negocio.md`.
- [ ] Tras la cascada existen `specs/06-modulo-catalog.md`, `specs/07-modulo-order.md` y `specs/08-modulo-payments.md`, todos con las siete secciones de la plantilla y la sección final «Qué no está».
- [ ] Cada spec generado tiene `**Status:** Borrador` al crearse (o `Aprobado` solo si lo cambió el usuario) y `**Date:** 2026-11-07`.
- [ ] Cada `**Depends on:**` de los specs 06–08 referencia solo specs que existen en `specs/`.
- [ ] El spec 06 define los eventos `stock.reserved`, `stock.rejected` y `stock.released`; el 07 define `order.created`, `order.confirmed` y `order.cancelled` y la colección `outbox_events`; el 08 define `payment.approved` y `payment.declined`. Los nombres coinciden con la tabla de eventos de `docs/reglas-de-negocio.md`.
- [ ] El spec 07 declara que lee de `catalog` solo a través de `modules/catalog/index.js`, y el 08 de `order` solo a través de `modules/order/index.js`.
- [ ] Ningún spec generado decide ni implementa el transporte hacia `notifications`.
- [ ] El spec 08 incluye `Idempotency-Key`, los cinco tokens de prueba del simulador, la validación HMAC con timestamp y el límite de 10 req/min.
- [ ] Cada spec generado tiene un objetivo de una sola frase y un plan donde cada paso deja `npm test` en verde.
- [ ] `git status` tras la cascada muestra solo archivos nuevos bajo `.claude/agents/` y `specs/` (más ediciones de estado hechas por el usuario): ningún cambio en `apps/`, `libs/`, `docs/` ni `CLAUDE.md`.

## Decisiones

- **Sí:** tres subagentes de proyecto en `.claude/agents/`. Quedan versionados, revisables en git y reutilizables si hay que regenerar un spec.
- **No:** un solo agente parametrizado por módulo. Pierde el contexto específico de cada dominio (saga, simulador de pagos, catálogo) y el prompt se vuelve genérico.
- **No:** prompts incrustados en este spec. Se pierden al no haber un archivo ejecutable y no se pueden reutilizar.
- **Sí:** los agentes solo redactan specs. Respeta el método (spec → revisión humana → `/spec-impl`) y evita que un error de diseño se convierta en código sin que nadie lo vea.
- **No:** spec más implementación en el mismo agente. Un fallo en `catalog` contaminaría `order` y `payments` ya implementados.
- **Sí:** cascada en orden `catalog → order → payments`. Es el orden de dependencia de la saga: `order` reserva stock en `catalog`, y `payments` toma el monto de `order`.
- **No:** ejecución en paralelo. Los contratos (eventos, `index.ts`) podrían quedar incompatibles porque cada agente no vería el spec de los demás.
- **Sí:** aprobación humana entre cada agente. El spec anterior es la entrada del siguiente; si se aprueba con errores, se propagan.
- **No:** cascada de un solo disparo sin pausas. Es más rápida, pero la revisión llegaría cuando ya hay tres specs encadenados.
- **Sí:** los agentes preguntan en lugar de decidir y las preguntas pasan por la sesión principal. Los subagentes no hablan con el usuario directamente; delegar la pregunta mantiene la regla «nunca asumir decisiones sin confirmar» de `/spec`.
- **Sí:** herramientas limitadas a `Read, Glob, Grep, Write`. Un agente que redacta documentos no necesita ejecutar comandos ni editar código, y así no puede tocar `apps/` por error.
- **Sí:** eventos en memoria y outbox en Mongo, sin transporte externo. Cumple la garantía transaccional de las reglas de negocio sin decidir RabbitMQ, que sigue abierto en `CLAUDE.md`.
- **No:** incluir el transporte hacia `notifications` en estos specs. Es una decisión de infraestructura propia y merece su spec.
- **Sí:** numeración fija 06, 07 y 08 reservada aquí. Evita que otro spec ocupe un número a mitad de la cascada.
- **Sí:** el orquestador es la sesión principal. Un subagente no puede lanzar otros subagentes, y un orquestador automático (comando `/cascada`) es una mejora aparte.
- **Sí:** reglas de negocio ambiguas se reportan, no se corrigen en el agente. `docs/reglas-de-negocio.md` es un documento vivo que se actualiza en el mismo cambio que toca el código.

## Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Los agentes redactan specs demasiado grandes (p. ej. `order` con carrito, saga y outbox) | Cada prompt exige que el objetivo quepa en una frase; si no cabe, el agente devuelve una propuesta de división y la sesión principal la consulta al usuario antes de escribir. |
| Un contrato queda mal definido en 06 y se propaga a 07 y 08 | La aprobación humana entre agentes; los criterios exigen que los nombres de eventos y la API pública coincidan con la tabla de eventos de las reglas de negocio. |
| Los subagentes no pueden usar `AskUserQuestion` y deciden por su cuenta | El prompt les prohíbe decidir lo ambiguo: devuelven las preguntas y no escriben el archivo hasta recibir respuestas. |
| Un agente escribe fuera de su spec o toca el documento vivo | Herramienta `Write` acotada por instrucción, `Bash` y `Edit` fuera de su lista de herramientas y criterio de aceptación sobre `git status`. |
| Las reglas de negocio tienen huecos (p. ej. carrito, reintentos de webhook) | Los agentes los reportan como preguntas; las respuestas se registran en la sección «Decisiones» del spec correspondiente. |
| Claude Code no reconoce los agentes hasta recargar la sesión | El paso 4 verifica su disponibilidad antes de lanzar la cascada. |

## Qué **no** está en este spec

- Implementación de `catalog`, `order` o `payments`.
- Transporte de eventos hacia `notifications` y su consumo.
- Cambios en `docs/reglas-de-negocio.md` o en `CLAUDE.md`.
- Un orquestador automático o comando `/cascada`.
- Agentes para `auth` o `notifications`.
- Lint, CI o hooks que verifiquen la cascada.

Cada uno de estos, si se aborda, va en su propio spec.
