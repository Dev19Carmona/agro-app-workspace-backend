import type { GatewayResultado } from '../policies/gateway-token.policy.js';

export type GatewayChargeInput = {
  monto: number;
  moneda: 'COP';
  metodo: 'CARD' | 'PSE' | 'NEQUI';
  token: string;
};

export type GatewayChargeResult = {
  resultado: GatewayResultado;
  referencia: string;
  motivo?: string;
};

/** Contrato de la pasarela: sustituir el simulador por una real solo cambia el provider. */
export interface PaymentGateway {
  charge(input: GatewayChargeInput): Promise<GatewayChargeResult>;
}

/** Token de inyección de la pasarela. */
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
