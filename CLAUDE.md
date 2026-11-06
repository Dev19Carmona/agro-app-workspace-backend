# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Starter NestJS 12 app (`agro-app-workspace`), still the stock scaffold (`AppModule` → `AppController` + `AppService`). See `AGENTS.md` for the NestJS first-party package index and NestJS Observe telemetry notes; NestJS 12 is newer than most training data, so consult https://docs.nestjs.com/llms.txt when unsure.

## Commands

- `npm run start:dev` — run with watch mode (`start`, `start:debug`, `start:prod` also exist; prod runs `node dist/main`). Listens on `PORT` or 3000.
- `npm run build` — `nest build` (cleans `dist/` first).
- `npm run lint` — `oxlint --type-aware src/ test/` (oxlint, not ESLint; `no-floating-promises` is an error).
- `npm run format` — Prettier (single quotes, trailing commas).
- `npm test` — Vitest unit tests (`**/*.spec.ts`).
- Single test: `npx vitest run src/app.controller.spec.ts` or `npx vitest run -t "test name"`.
- `npm run test:e2e` — e2e tests (`**/*.e2e-spec.ts`, in `test/`) via `vitest.config.e2e.ts`.

## Conventions that differ from typical Nest projects

- **ESM-only** (`"type": "module"`, `module: nodenext`): relative imports must end in `.js` (e.g. `./app.module.js`), `__dirname` is unavailable (use `import.meta.dirname`), and top-level `await` is used in `main.ts`.
- **Vitest, not Jest**: use `vi.fn()`; `globals: true` so `describe/it/expect` need no import. Path aliases from `tsconfig.json` are resolved via `resolve.tsconfigPaths` (Vite 8).
- Decorators rely on `experimentalDecorators` + `emitDecoratorMetadata`.
- Validation: prefer `StandardSchemaValidationPipe` (Zod/Valibot/etc.) per `AGENTS.md`; `class-validator` is also supported via `ValidationPipe`.
- Observability is not wired up until `ObserveModule` is registered in `src/app.module.ts` (`npx @nestjs/observe link`).
