import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as publicApi from '../index.js';

const moduleDir = join(import.meta.dirname, '..');
const modulesDir = join(moduleDir, '..');

/** Todos los `.ts` de una carpeta, recursivo. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? tsFiles(path)
      : path.endsWith('.ts')
        ? [path]
        : [];
  });
}

describe('API pública de notification-inbox (index.ts)', () => {
  it('exporta solo NotificationInboxModule', () => {
    expect(Object.keys(publicApi)).toEqual(['NotificationInboxModule']);
  });

  it('en la raíz del módulo solo hay index.ts y notification-inbox.module.ts', () => {
    const archivos = readdirSync(moduleDir).filter((n) =>
      statSync(join(moduleDir, n)).isFile(),
    );
    expect(archivos.sort()).toEqual([
      'index.ts',
      'notification-inbox.module.ts',
    ]);
  });

  it('todos los specs están planos en tests/', () => {
    const specs = tsFiles(moduleDir).filter((f) => f.endsWith('.spec.ts'));
    expect(specs.every((f) => join(f, '..') === join(moduleDir, 'tests'))).toBe(
      true,
    );
  });

  it('ningún otro módulo importa archivos internos de notification-inbox', () => {
    const otros = readdirSync(modulesDir).filter(
      (n) =>
        n !== 'notification-inbox' &&
        statSync(join(modulesDir, n)).isDirectory(),
    );
    const infractores = otros
      .flatMap((m) => tsFiles(join(modulesDir, m)))
      .filter((f) =>
        /from\s+['"][^'"]*notification-inbox\/(?!index\.js)[^'"]+['"]/.test(
          readFileSync(f, 'utf8'),
        ),
      );
    expect(infractores).toEqual([]);
  });

  it('notification-inbox y notification-bridge no se importan entre sí', () => {
    const delInbox = tsFiles(moduleDir).filter((f) => !f.includes('tests'));
    const delBridge = tsFiles(join(modulesDir, 'notification-bridge'));
    expect(
      delInbox.filter((f) =>
        /from\s+['"][^'"]*notification-bridge/.test(readFileSync(f, 'utf8')),
      ),
    ).toEqual([]);
    expect(
      delBridge.filter((f) =>
        /from\s+['"][^'"]*notification-inbox/.test(readFileSync(f, 'utf8')),
      ),
    ).toEqual([]);
  });

  it('api no lee colecciones de notifications: el módulo no usa mongoose', () => {
    const usaMongoose = tsFiles(moduleDir)
      .filter((f) => !f.includes('tests'))
      .filter((f) => /mongoose/.test(readFileSync(f, 'utf8')));
    expect(usaMongoose).toEqual([]);
  });
});
