/** Reintentos de publicación del puente (sin Nest). Copia propia: no se importa de `order`. */

export const MAX_PUBLISH_ATTEMPTS = 5;
const BASE_MS = 2_000;
const CAP_MS = 60_000;

/** Espera tras el fallo número `attempts`: min(2 s × 2^attempts, 60 s). */
export function backoffMs(attempts: number): number {
  return Math.min(BASE_MS * 2 ** attempts, CAP_MS);
}

/** `true` si con `attempts` fallos el evento pasa a `FAILED`. */
export function isExhausted(attempts: number): boolean {
  return attempts >= MAX_PUBLISH_ATTEMPTS;
}
