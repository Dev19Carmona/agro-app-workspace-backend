import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Roles } from './decorators.js';
import { Role, type AuthenticatedUser } from './roles.js';
import { RolesGuard } from './roles.guard.js';

class Controlador {
  @Roles(Role.ADMIN)
  soloAdmin() {}

  @Roles(Role.ADMIN, Role.PROVEEDOR)
  varios() {}

  libre() {}
}
const handler = (n: keyof Controlador): Function =>
  Reflect.get(Controlador.prototype, n);

function contexto(metodo: keyof Controlador, rol?: Role) {
  const user: AuthenticatedUser | undefined = rol && {
    id: 'u1',
    rol,
    sessionId: 's1',
  };
  return {
    getHandler: () => handler(metodo),
    getClass: () => Controlador,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('permite una ruta sin @Roles', () => {
    expect(guard.canActivate(contexto('libre', Role.PRODUCTOR))).toBe(true);
  });

  it('permite el rol requerido', () => {
    expect(guard.canActivate(contexto('soloAdmin', Role.ADMIN))).toBe(true);
  });

  it('permite cualquiera de varios roles', () => {
    expect(guard.canActivate(contexto('varios', Role.PROVEEDOR))).toBe(true);
  });

  it('responde 403 a un rol no permitido', () => {
    expect(() =>
      guard.canActivate(contexto('soloAdmin', Role.PRODUCTOR)),
    ).toThrow(ForbiddenException);
  });

  it('responde 403 si hay @Roles pero no hay usuario', () => {
    expect(() => guard.canActivate(contexto('soloAdmin'))).toThrow(
      ForbiddenException,
    );
  });
});
