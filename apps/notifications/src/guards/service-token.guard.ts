import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Env } from '../../../../libs/common/src/config/env.schema.js';

export const SERVICE_TOKEN_HEADER = 'x-service-token';

/** SHA-256 de ambos lados: así `timingSafeEqual` recibe buffers del mismo largo. */
const sha256 = (value: string): Buffer =>
  createHash('sha256').update(value).digest();

/**
 * Protege la API interna: exige `X-Service-Token` igual a `INTERNAL_SERVICE_TOKEN`.
 * Header ausente, repetido o distinto: 401 sin detalle. Nunca registra el valor.
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const received = request.headers[SERVICE_TOKEN_HEADER];
    // Un header repetido llega como lista o unido con coma: ninguno de los dos es válido.
    if (typeof received !== 'string' || received.length === 0) {
      throw new UnauthorizedException();
    }
    const expected = this.config.get('INTERNAL_SERVICE_TOKEN', { infer: true });
    if (!timingSafeEqual(sha256(received), sha256(expected))) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
