/** Reglas puras del simulador de pasarela (sin Nest). */

export type GatewayResultado = 'APPROVED' | 'DECLINED' | 'ERROR' | 'PROCESSING';

export type GatewayOutcome = { resultado: GatewayResultado; motivo?: string };

export const MIN_LATENCY_MS = 1000;
export const MAX_LATENCY_MS = 3000;

/** Mapea el token de prueba al resultado del simulador; cualquier otro es `INVALID_TOKEN`. */
export function resolveGatewayOutcome(token: string): GatewayOutcome {
  switch (token) {
    case 'tok_test_approved':
      return { resultado: 'APPROVED' };
    case 'tok_test_declined':
      return { resultado: 'DECLINED', motivo: 'INSUFFICIENT_FUNDS' };
    case 'tok_test_error':
      return { resultado: 'ERROR', motivo: 'GATEWAY_ERROR' };
    case 'tok_test_pending':
      return { resultado: 'PROCESSING' };
    default:
      return { resultado: 'DECLINED', motivo: 'INVALID_TOKEN' };
  }
}

/** Entero entre 1000 y 3000 ms; `random` devuelve un número en [0, 1). */
export function randomLatencyMs(random: () => number = Math.random): number {
  return MIN_LATENCY_MS + Math.floor(random() * (MAX_LATENCY_MS - MIN_LATENCY_MS + 1));
}
