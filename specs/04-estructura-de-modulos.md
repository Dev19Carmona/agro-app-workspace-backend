# SPEC 04 — Estructura estándar de los módulos del monolito

> **Status:** Aprobado
> **Depends on:** SPEC 03
> **Date:** 2026-11-07
> **Objective:** Reorganizar `auth` (y los esqueletos `catalog`, `order` y `payments`) con una estructura de carpetas por tipo de archivo, una sola carpeta `tests/` y un `index.ts` como API pública, y dejar esa estructura escrita como regla en `CLAUDE.md` para todo módulo futuro.

## Por qué existe este spec

Hoy `apps/api/src/modules/auth/` tiene 24 archivos: 3 controllers, 4 services, la política de contraseña y los eventos sueltos en la raíz, junto a 9 `*.spec.ts` mezclados con el código. Solo `dto/` y `schemas/` tienen carpeta. Es difícil ver de un vistazo qué hace el módulo, y cada módulo nuevo (`catalog`, `order`, `payments`) copiaría ese desorden o inventaría el suyo.

Este spec es un refactor puro: **no cambia comportamiento, endpoints, schemas ni reglas de negocio.** Fija una estructura única, la aplica a los cuatro módulos existentes y la documenta para que cada módulo nuevo nazca con la misma forma.

Se apoya en `arch-feature-modules` de la skill `nestjs-best-practices` (organizar por funcionalidad, no por capa técnica a nivel de `src/`): la unidad es el módulo; dentro de él, las carpetas son por tipo de archivo.

## Alcance

**Dentro:**

- **Estructura estándar** de un módulo en `apps/api/src/modules/<dominio>/`:
  - En la raíz solo `index.ts` y `<dominio>.module.ts`.
  - Carpetas por tipo, creadas **solo cuando tienen contenido** (nunca carpetas vacías ni `.gitkeep`): `controllers/`, `services/`, `dto/`, `schemas/`, `events/`, `policies/`, `tests/`.
  - **`tests/` es la única carpeta de pruebas unitarias** del módulo: todos los `*.spec.ts` van ahí, con nombres planos (sin subcarpetas) y el mismo nombre del archivo que prueban más `.spec.ts`.
  - Los nombres de archivo no cambian (`auth.service.ts`, `users-admin.controller.ts`, etc.); solo cambia la carpeta.
- **`index.ts` por módulo** como API pública: es lo único que otros módulos (y `ApiModule`) pueden importar de él. Nunca se importa un archivo interno de otro módulo.
- **Reorganización de `auth`** con `git mv` (conserva historial) y actualización de imports.
- **Reorganización de `catalog`, `order` y `payments`** (esqueletos): `controllers/`, `services/`, `tests/`, `<dominio>.module.ts` e `index.ts`.
- **Ajuste de referencias externas** a rutas de `auth`: `scripts/seed-admin.ts` (importa `password.policy`) y `apps/api/test/auth.e2e-spec.ts` (importa `password.service`).
- **Regla en `CLAUDE.md`:** nueva sección "Estructura de un módulo" con el árbol, las reglas de ubicación y la regla del `index.ts`; corregir la mención de `auth.events.ts` en "Seguridad".

**Fuera de alcance (para specs futuros):**

- Cualquier cambio de comportamiento, endpoint, schema, DTO o regla de negocio.
- Mover los tests e2e: siguen en `apps/api/test/`.
- Mover `libs/common/src/**` (security, config, health): su estructura propia no cambia.
- Regla de lint que haga cumplir la estructura o el `index.ts` (p. ej. `no-restricted-imports` en oxlint).
- Extraer repositorios (`arch-use-repository-pattern`), partir `AuthService` u otras mejoras de diseño interno.
- Cambiar `notifications`: es un servicio aparte y no sigue esta estructura todavía.
- Editar `specs/03-modulo-auth.md`: documenta las rutas del momento en que se escribió y no se mantiene.

## Modelo de datos

Este spec no introduce datos nuevos, colecciones ni variables de entorno. Fija la estructura de carpetas.

Estructura estándar:

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

Estructura resultante de `auth`:

```text
apps/api/src/modules/auth/
  index.ts
  auth.module.ts
  controllers/
    auth.controller.ts
    users-admin.controller.ts
  services/
    auth.service.ts
    users.service.ts
    token.service.ts
    password.service.ts
  dto/
    login.dto.ts
    register.dto.ts
    session.dto.ts
    users-admin.dto.ts
  schemas/
    user.schema.ts
    refresh-token.schema.ts
  events/
    auth.events.ts
  policies/
    password.policy.ts
  tests/
    auth.controller.spec.ts
    users-admin.controller.spec.ts
    auth.service.spec.ts
    users.service.spec.ts
    token.service.spec.ts
    password.service.spec.ts
    auth.dto.spec.ts          # antes dto/auth.dto.spec.ts
    schemas.spec.ts           # antes schemas/schemas.spec.ts
    seed-admin.spec.ts
```

Estructura resultante de `catalog`, `order` y `payments` (ejemplo con `catalog`; `order` y `payments` igual con su nombre):

```text
apps/api/src/modules/catalog/
  index.ts
  catalog.module.ts
  controllers/catalog.controller.ts
  services/catalog.service.ts
  tests/catalog.controller.spec.ts
```

Contenido inicial de cada `index.ts`:

| Módulo | Exporta |
| --- | --- |
| `auth` | `AuthModule`, `AuthEvents` y los tipos `UserRegisteredEvent`, `ProviderApprovedEvent`, `ProviderRejectedEvent` |
| `catalog`, `order`, `payments` | Su `*Module` |

Reglas de imports:

- Dentro de un módulo se importa por ruta relativa al archivo concreto, con extensión `.js` (convención ESM del repo).
- Desde fuera (`ApiModule`, otro módulo) se importa solo `modules/<dominio>/index.js`.
- Los tests importan por ruta relativa al archivo interno (`../services/auth.service.js`); no pasan por el `index.ts`.
- Una carpeta nueva fuera de la lista (p. ej. `guards/`) solo se añade si el módulo la necesita de verdad, y se agrega a la lista en `CLAUDE.md` en el mismo cambio.

## Plan de implementación

Cada paso deja el sistema compilando y con `npm test` en verde. Usar `git mv` para mover archivos.

1. **Mover `auth` y arreglar imports.** Crear las carpetas `controllers/`, `services/`, `events/`, `policies/` y `tests/`; mover cada archivo según el árbol de arriba (los 9 specs a `tests/`, incluidos `dto/auth.dto.spec.ts` y `schemas/schemas.spec.ts`). Actualizar todos los imports relativos: los de `libs/common/...` ganan un nivel (`../../../../../libs` → `../../../../../../libs`) en los archivos que bajan a una subcarpeta, y los specs apuntan a `../services/...`, `../controllers/...`, `../dto/...`, `../schemas/...`. Actualizar también `scripts/seed-admin.ts` (→ `policies/password.policy.ts`), `tests/seed-admin.spec.ts` (ruta a `scripts/`) y `apps/api/test/auth.e2e-spec.ts` (→ `services/password.service.js`). Comprobar con `npm run build:all`, `npm test` y `npm run lint`.
2. **`index.ts` de `auth`.** Crear `auth/index.ts` con las exportaciones de la tabla y cambiar `api.module.ts` para importar `AuthModule` desde `./modules/auth/index.js`.
3. **Reorganizar `catalog`, `order` y `payments`.** Crear `controllers/`, `services/` y `tests/`, mover sus archivos, actualizar imports, crear sus `index.ts` y cambiar `api.module.ts` para importarlos desde los `index.js`.
4. **Regla en `CLAUDE.md`.** Agregar la sección "Estructura de un módulo" (árbol, ubicación de cada tipo de archivo, `tests/` única y plana, `index.ts` como API pública, carpetas solo con contenido) y corregir la referencia a `auth.events.ts` en "Seguridad" (`events/auth.events.ts`). Ajustar en "Commands" la nota de tests colocados junto al código: los unitarios viven en `tests/` de cada módulo.
5. **Verificación final.** Ejecutar `npm run build:all`, `npm run lint`, `npm test` y `npm run test:e2e`, y comprobar que el número de tests unitarios es el mismo que antes del refactor.

## Criterios de aceptación

- [ ] En la raíz de cada módulo (`auth`, `catalog`, `order`, `payments`) solo existen `index.ts`, `<dominio>.module.ts` y carpetas de la lista estándar.
- [ ] No queda ningún `*.spec.ts` fuera de `modules/<dominio>/tests/` dentro de `apps/api/src/modules/`, y `tests/` no tiene subcarpetas.
- [ ] Ninguna carpeta de módulo está vacía y no hay `.gitkeep`.
- [ ] `auth` coincide con el árbol del spec: 2 controllers en `controllers/`, 4 services en `services/`, 4 DTO en `dto/`, 2 schemas en `schemas/`, `auth.events.ts` en `events/`, `password.policy.ts` en `policies/` y 9 specs en `tests/`.
- [ ] `ApiModule` importa los cuatro módulos desde `modules/<dominio>/index.js`, y ningún archivo fuera de `modules/auth/` importa un archivo interno de `auth` (salvo `scripts/seed-admin.ts` para `policies/password.policy.ts` y `apps/api/test/auth.e2e-spec.ts` para `services/password.service.js`, excepciones ya existentes).
- [ ] El número de tests unitarios que reporta `npm test` es idéntico al de antes del refactor y todos pasan.
- [ ] `git log --follow` sobre un archivo movido (p. ej. `controllers/auth.controller.ts`) muestra su historial anterior.
- [ ] `npm run seed:admin` sigue funcionando (importa `password.policy` desde su nueva ruta).
- [ ] `npm run build:all`, `npm run lint`, `npm test` y `npm run test:e2e` terminan sin errores.
- [ ] `git diff` no contiene cambios de comportamiento: fuera de mover archivos y editar sentencias `import`/`export`, solo cambian `index.ts` nuevos, `api.module.ts`, `scripts/seed-admin.ts`, el e2e y `CLAUDE.md`.
- [ ] `CLAUDE.md` tiene la sección "Estructura de un módulo" con el árbol estándar y las reglas de `tests/` e `index.ts`.

## Decisiones

- **Sí:** carpetas por tipo de archivo dentro del módulo. La regla es mecánica («un controller va en `controllers/`»), así que cada módulo nuevo la aplica igual sin interpretar.
- **No:** carpetas por subfuncionalidad (`session/`, `users-admin/`, `tokens/`). Es más cohesivo pero subjetivo: cada módulo trazaría los límites distinto y la regla dejaría de ser predecible.
- **No:** estructura híbrida (carpeta solo si hay más de 3 archivos). Obliga a mover archivos cuando un módulo crece y hace impredecible dónde buscar.
- **Sí:** una sola carpeta `tests/` plana por módulo. Saca el ruido de las carpetas de código sin perder cercanía (sigue dentro del módulo) y vitest ya los encuentra con `apps/**/*.spec.ts`, sin cambiar configuración.
- **No:** `tests/` espejo con subcarpetas. Con ~9 specs por módulo agrega anidación sin ganar claridad; los nombres ya indican qué prueban.
- **No:** mover los unitarios a `apps/api/test/`. Aleja el test del código que prueba y mezcla unitarios con e2e.
- **Sí:** `index.ts` como API pública de cada módulo. Hace verificable la regla de CLAUDE.md «no importar archivos internos de otro módulo» y facilita extraer un módulo a servicio después.
- **No:** regla de lint que fuerce el `index.ts`. Es trabajo aparte; por ahora es convención escrita en `CLAUDE.md`.
- **Sí:** aplicar la estructura a `catalog`, `order` y `payments` ya. Mover tres esqueletos pequeños cuesta poco y evita que queden dos formas de organizar un módulo en el repo.
- **Sí:** `events/` y `policies/` como carpetas propias. Los eventos son contrato público (los consumirá `notifications`) y la política de contraseña es lógica pura sin Nest que también usa `scripts/seed-admin.ts`; ninguno es un service.
- **Sí:** carpetas solo cuando tienen contenido. Evita árboles con carpetas vacías en módulos que aún no tienen DTO o schemas.
- **Sí:** nombres de archivo sin cambios y movimiento con `git mv`. El diff queda como renombrados y el historial se conserva.
- **No:** editar `specs/03-modulo-auth.md`. Es la foto del momento y no se mantiene; la fuente vigente de la estructura es `CLAUDE.md`.
- **No:** mezclar este refactor con mejoras de diseño (repositorios, partir servicios). Un refactor de solo movimiento es fácil de revisar y de revertir.

## Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Los imports a `libs/common` usan rutas relativas largas (no hay alias); mover archivos un nivel más abajo los rompe | Actualizarlos en el paso 1 y comprobar con `build:all`, `lint` y `npm test` antes de seguir. Un alias de ruta queda como mejora para otro spec. |
| `scripts/seed-admin.ts` se ejecuta sin transpilar y queda fuera de lint y typecheck, así que un import roto no lo detecta ni el build | Criterio de aceptación explícito: ejecutar `npm run seed:admin`; además `tests/seed-admin.spec.ts` lo importa y falla si la ruta está mal. |
| El e2e (`apps/api/test/auth.e2e-spec.ts`) importa `password.service.js` por ruta interna y se rompe en silencio | Actualizar la ruta en el paso 1 y correr `npm run test:e2e` en el paso 5. |
| `nest build` con rspack incluye los `*.spec.ts` si siguen dentro de `src` | No cambia respecto a hoy; `tests/` queda dentro de `src` igual que antes. Si se quisiera excluirlos del build, sería un spec aparte. |
| Los módulos nuevos ignoran la estructura | Queda en `CLAUDE.md`, que se carga en cada sesión, y es criterio de aceptación de cada spec de dominio futuro. |
| ESM: imports relativos sin `.js` rompen el build | Seguir la convención del repo (`./archivo.js`). |

## Qué **no** está en este spec

- Cambios de comportamiento, endpoints, schemas o reglas de negocio.
- Mover los tests e2e o reorganizar `libs/common`.
- Lint que haga cumplir la estructura o el `index.ts`.
- Repositorios, división de servicios y otras mejoras de diseño interno.
- Aplicar la estructura a `notifications`.

Cada uno de estos, si se aborda, va en su propio spec.
