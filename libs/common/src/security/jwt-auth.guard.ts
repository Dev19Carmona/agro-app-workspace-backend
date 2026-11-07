import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from './decorators.js';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './security.constants.js';
import {
  type AccessTokenPayload,
  type AuthenticatedUser,
  Role,
} from './roles.js';

type RequestWithUser = {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
};

/**
 * Guard global: todo endpoint exige un access token válido salvo `@Public()`.
 * Verifica con la clave pública, fijando algoritmo, emisor y audiencia, de modo
 * que `HS256` o `alg: none` nunca se aceptan.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.extractBearerToken(request);
    if (!token) throw new UnauthorizedException('No autenticado');

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        algorithms: [JWT_ALGORITHM],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
    } catch {
      throw new UnauthorizedException('No autenticado');
    }

    request.user = this.toAuthenticatedUser(payload);
    return true;
  }

  private extractBearerToken(request: RequestWithUser): string | undefined {
    const header = request.headers['authorization'];
    if (typeof header !== 'string') return undefined;
    const [type, token, ...rest] = header.split(' ');
    return type === 'Bearer' && token && rest.length === 0 ? token : undefined;
  }

  /** Un token bien firmado pero con claims incompletos o de otro tipo no sirve. */
  private toAuthenticatedUser(payload: AccessTokenPayload): AuthenticatedUser {
    const { sub, rol, sid, storeId } = payload;
    const validRole = Object.values(Role).includes(rol);
    if (
      typeof sub !== 'string' ||
      typeof sid !== 'string' ||
      !validRole ||
      (storeId !== undefined && typeof storeId !== 'string')
    ) {
      throw new UnauthorizedException('No autenticado');
    }
    return { id: sub, rol, sessionId: sid, ...(storeId && { storeId }) };
  }
}
