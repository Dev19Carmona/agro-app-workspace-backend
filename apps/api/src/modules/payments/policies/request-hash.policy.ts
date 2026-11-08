import { createHash } from 'node:crypto';

/** SHA-256 hexadecimal de `orderId|metodo|token`; el token no se guarda, solo entra aquí. */
export function computeRequestHash(input: {
  orderId: string;
  metodo: string;
  token: string;
}): string {
  return createHash('sha256')
    .update(`${input.orderId}|${input.metodo}|${input.token}`)
    .digest('hex');
}
