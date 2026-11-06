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
- `libs/common` guarda código compartido (p. ej. `setupSwagger`).

## Commands

- `npm run start:dev` — run `api` (default project) with watch mode (`start`, `start:debug`, `start:prod` also exist; prod runs `node dist/apps/api/main`). Listens on `PORT` or 3000. `npm run start:dev:notifications` / `npm run start:prod:notifications` run the notifications service (port 3005; prod runs `node dist/apps/notifications/main`).
- `npm run build` — `nest build` of `api` only (cleans `dist/`). `npm run build:all` builds `api` and `notifications`.
- `npm run lint` — `oxlint --type-aware apps/ libs/` (oxlint, not ESLint; `no-floating-promises` is an error).
- `npm run format` — Prettier (single quotes, trailing commas).
- `npm test` — Vitest unit tests (`**/*.spec.ts`, colocated next to the code under `apps/` and `libs/`).
- Single test: `npx vitest run apps/api/src/modules/auth/auth.controller.spec.ts` or `npx vitest run -t "test name"`.
- `npm run test:e2e` — e2e tests (`**/*.e2e-spec.ts`, in `apps/<app>/test/`) via `vitest.config.e2e.ts`.

## Conventions that differ from typical Nest projects

- **ESM-only** (`"type": "module"`, `module: nodenext`): relative imports must end in `.js` (e.g. `./app.module.js`), `__dirname` is unavailable (use `import.meta.dirname`), and top-level `await` is used in `main.ts`.
- **Vitest, not Jest**: use `vi.fn()`; `globals: true` so `describe/it/expect` need no import. Path aliases from `tsconfig.json` are resolved via `resolve.tsconfigPaths` (Vite 8).
- Decorators rely on `experimentalDecorators` + `emitDecoratorMetadata`.
- Validation: prefer `StandardSchemaValidationPipe` (Zod/Valibot/etc.) per `AGENTS.md`; `class-validator` is also supported via `ValidationPipe`.
- Observability is not wired up until `ObserveModule` is registered in `apps/api/src/api.module.ts` (`npx @nestjs/observe link`).
