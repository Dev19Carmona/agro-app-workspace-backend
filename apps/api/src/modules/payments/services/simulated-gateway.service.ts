import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  randomLatencyMs,
  resolveGatewayOutcome,
} from '../policies/gateway-token.policy.js';
import type {
  GatewayChargeInput,
  GatewayChargeResult,
  PaymentGateway,
} from './payment-gateway.js';

/** Pasarela simulada: espera de 1 a 3 s y responde según el token. No persiste nada. */
@Injectable()
export class SimulatedGatewayService implements PaymentGateway {
  async charge(input: GatewayChargeInput): Promise<GatewayChargeResult> {
    const latencia = randomLatencyMs();
    await new Promise<void>((resolve) => setTimeout(resolve, latencia));
    const { resultado, motivo } = resolveGatewayOutcome(input.token);
    return {
      resultado,
      referencia: `SIM-${randomUUID()}`,
      ...(motivo ? { motivo } : {}),
    };
  }
}
