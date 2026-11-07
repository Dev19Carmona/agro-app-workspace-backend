import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  CurrentUser,
  IS_PUBLIC_KEY,
  Public,
  ROLES_KEY,
  Roles,
} from './decorators.js';
import { Role, type AuthenticatedUser } from './roles.js';

const user: AuthenticatedUser = {
  id: 'u1',
  rol: Role.ADMIN,
  sessionId: 's1',
  storeId: 'st1',
};

class Demo {
  @Public()
  abierto() {}

  @Roles(Role.ADMIN, Role.PROVEEDOR)
  restringido() {}

  privado() {}

  completo(@CurrentUser() _user: AuthenticatedUser) {}

  campo(@CurrentUser('id') _id: string) {}
}

/** Extrae la factory del decorador de parámetro, como hace Nest al resolver argumentos. */
function resolverParametro(metodo: keyof Demo, request: object) {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Demo, metodo) as Record<
    string,
    { factory: Function; data: unknown }
  >;
  const { factory, data } = Object.values(args)[0];
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return factory(data, ctx);
}

/** Handler del método por nombre; evita referenciar métodos sin enlazar. */
const handler = (nombre: keyof Demo): Function =>
  Reflect.get(Demo.prototype, nombre);

describe('decoradores de seguridad', () => {
  const reflector = new Reflector();

  it('@Public marca la ruta como pública', () => {
    expect(reflector.get(IS_PUBLIC_KEY, handler('abierto'))).toBe(true);
  });

  it('una ruta sin @Public no lleva la marca', () => {
    expect(reflector.get(IS_PUBLIC_KEY, handler('privado'))).toBeUndefined();
  });

  it('@Roles guarda los roles permitidos', () => {
    expect(reflector.get(ROLES_KEY, handler('restringido'))).toEqual([
      Role.ADMIN,
      Role.PROVEEDOR,
    ]);
  });

  it('una ruta sin @Roles no declara roles', () => {
    expect(reflector.get(ROLES_KEY, handler('privado'))).toBeUndefined();
  });

  it('@CurrentUser() devuelve el usuario de la petición', () => {
    expect(resolverParametro('completo', { user })).toEqual(user);
  });

  it("@CurrentUser('id') devuelve solo ese campo", () => {
    expect(resolverParametro('campo', { user })).toBe('u1');
  });

  it('@CurrentUser() devuelve undefined si no hay usuario', () => {
    expect(resolverParametro('completo', {})).toBeUndefined();
    expect(resolverParametro('campo', {})).toBeUndefined();
  });
});

describe('Role', () => {
  it('define exactamente los tres roles del negocio', () => {
    expect(Object.values(Role).sort()).toEqual([
      'ADMIN',
      'PRODUCTOR',
      'PROVEEDOR',
    ]);
  });
});
