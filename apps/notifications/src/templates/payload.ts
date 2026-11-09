import type { WireEvent } from '../../../../libs/common/src/messaging/domain-event.schema.js';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** Payload mal formado: reintentar no lo arregla, pero el consumidor lo trata como fallo. */
export class InvalidEventPayloadError extends Error {
  constructor(type: string, campo: string) {
    super(`Payload inválido en ${type}: ${campo}`);
    this.name = 'InvalidEventPayloadError';
  }
}

/** ObjectId en hexadecimal (24 caracteres) o lanza. */
export function requireObjectId(event: WireEvent, campo: string): string {
  const value = event.payload[campo];
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) {
    throw new InvalidEventPayloadError(event.type, campo);
  }
  return value;
}

/** Arreglo no vacío de ObjectId válidos y sin repetidos, o lanza. */
export function requireObjectIdList(event: WireEvent, campo: string): string[] {
  const value = event.payload[campo];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((id) => typeof id !== 'string' || !OBJECT_ID.test(id)) ||
    new Set(value).size !== value.length
  ) {
    throw new InvalidEventPayloadError(event.type, campo);
  }
  return value as string[];
}

/** Entero no negativo (pesos COP) o lanza. */
export function requireMonto(event: WireEvent, campo: string): number {
  const value = event.payload[campo];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new InvalidEventPayloadError(event.type, campo);
  }
  return value;
}

/** `1250000` → `$1.250.000` (es-CO, sin decimales). */
export function formatCop(monto: number): string {
  return `$${monto.toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;
}
