import {
  createParamDecorator,
  SetMetadata,
  type CustomDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { AuthenticatedUser, Role } from './roles.js';

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';

/** Excepción al guard global: la ruta no exige token. */
export const Public = (): CustomDecorator<string> =>
  SetMetadata(IS_PUBLIC_KEY, true);

/** Exige que el usuario autenticado tenga alguno de estos roles. */
export const Roles = (...roles: Role[]): CustomDecorator<string> =>
  SetMetadata(ROLES_KEY, roles);

/**
 * Inyecta el usuario autenticado que dejó `JwtAuthGuard` en `request.user`.
 * Con una clave (`@CurrentUser('id')`) devuelve solo ese campo.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    return field ? user?.[field] : user;
  },
);
