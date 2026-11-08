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

describe('API pública de payments (index.ts)', () => {
  it('exporta solo PaymentsModule y PaymentEvents (los tipos se borran al compilar)', () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      'PaymentEvents',
      'PaymentsModule',
    ]);
  });

  it('PaymentEvents tiene los dos eventos del spec', () => {
    expect(publicApi.PaymentEvents).toEqual({
      PaymentApproved: 'payment.approved',
      PaymentDeclined: 'payment.declined',
    });
  });

  it('PaymentsModule es la clase del módulo', () => {
    expect(publicApi.PaymentsModule.name).toBe('PaymentsModule');
  });

  it('en la raíz del módulo solo hay index.ts y payments.module.ts', () => {
    const archivos = readdirSync(moduleDir).filter((n) =>
      statSync(join(moduleDir, n)).isFile(),
    );
    expect(archivos.sort()).toEqual(['index.ts', 'payments.module.ts']);
  });

  it('ningún otro módulo importa archivos internos de payments', () => {
    const otros = readdirSync(modulesDir).filter(
      (n) => n !== 'payments' && statSync(join(modulesDir, n)).isDirectory(),
    );
    const infractores = otros
      .flatMap((m) => tsFiles(join(modulesDir, m)))
      .filter((f) =>
        /from\s+['"][^'"]*payments\/(?!index\.js)[^'"]+['"]/.test(
          readFileSync(f, 'utf8'),
        ),
      );
    expect(infractores).toEqual([]);
  });

  it('payments solo importa de order desde su index.js y no habla con catalog', () => {
    const fuentes = tsFiles(moduleDir).filter((f) => !f.includes('tests'));
    const contenido = fuentes.map((f) => [f, readFileSync(f, 'utf8')] as const);
    const internosDeOrder = contenido.filter(([, c]) =>
      /from\s+['"][^'"]*\/order\/(?!index\.js)[^'"]+['"]/.test(c),
    );
    const usaCatalog = contenido.filter(([, c]) =>
      /from\s+['"][^'"]*\/catalog\//.test(c),
    );
    expect(internosDeOrder.map(([f]) => f)).toEqual([]);
    expect(usaCatalog.map(([f]) => f)).toEqual([]);
  });

  it('payments no escribe en outbox_events', () => {
    const fuentes = tsFiles(moduleDir).filter((f) => !f.includes('tests'));
    const usaOutbox = fuentes.filter((f) =>
      /OutboxService|OutboxEvent|outbox_events/.test(readFileSync(f, 'utf8')),
    );
    expect(usaOutbox).toEqual([]);
  });
});
