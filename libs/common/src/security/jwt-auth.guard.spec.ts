import { generateKeyPairSync } from 'node:crypto';
import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Public } from './decorators.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { Role } from './roles.js';
import { JWT_AUDIENCE, JWT_ISSUER } from './security.constants.js';

const pemOptions = {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
} as const;
const par = generateKeyPairSync('rsa', pemOptions);
const otroPar = generateKeyPairSync('rsa', pemOptions);

const claims = { sub: 'u1', rol: Role.PRODUCTOR, sid: 's1' };
const firmante = new JwtService({ privateKey: par.privateKey });
const firmar = (
  payload: object = claims,
  options: Parameters<JwtService['sign']>[1] = {},
) =>
  firmante.sign(payload, {
    algorithm: 'RS256',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: 900,
    ...options,
  });

class Controlador {
  @Public()
  abierto() {}

  privado() {}
}
const handler = (n: keyof Controlador): Function =>
  Reflect.get(Controlador.prototype, n);

function contexto(metodo: keyof Controlador, authorization?: string) {
  const request: { headers: Record<string, string>; user?: unknown } = {
    headers: authorization ? { authorization } : {},
  };
  const ctx = {
    getHandler: () => handler(metodo),
    getClass: () => Controlador,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

const base64url = (o: object) =>
  Buffer.from(JSON.stringify(o)).toString('base64url');

describe('JwtAuthGuard', () => {
  const guard = new JwtAuthGuard(
    new JwtService({ publicKey: par.publicKey }),
    new Reflector(),
  );
  const rechaza = (authorization?: string) =>
    expect(
      guard.canActivate(contexto('privado', authorization).ctx),
    ).rejects.toBeInstanceOf(UnauthorizedException);

  it('deja pasar una ruta @Public sin token', async () => {
    await expect(guard.canActivate(contexto('abierto').ctx)).resolves.toBe(
      true,
    );
  });

  it('acepta un token válido y deja el usuario en la petición', async () => {
    const { ctx, request } = contexto('privado', `Bearer ${firmar()}`);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toEqual({
      id: 'u1',
      rol: Role.PRODUCTOR,
      sessionId: 's1',
    });
  });

  it('incluye storeId cuando el token lo trae', async () => {
    const { ctx, request } = contexto(
      'privado',
      `Bearer ${firmar({ ...claims, storeId: 'st1' })}`,
    );
    await guard.canActivate(ctx);
    expect(request.user).toMatchObject({ storeId: 'st1' });
  });

  it('rechaza sin cabecera Authorization', () => rechaza());

  it('rechaza un esquema distinto de Bearer', () =>
    rechaza(`Basic ${firmar()}`));

  it('rechaza "Bearer" sin token', () => rechaza('Bearer '));

  it('rechaza un token malformado', () => rechaza('Bearer no.es.un-jwt'));

  it('rechaza un token firmado con otra clave', () =>
    rechaza(
      `Bearer ${new JwtService({ privateKey: otroPar.privateKey }).sign(
        claims,
        {
          algorithm: 'RS256',
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        },
      )}`,
    ));

  it('rechaza un token expirado', () =>
    rechaza(`Bearer ${firmar(claims, { expiresIn: -10 })}`));

  it('rechaza HS256 firmado con la clave pública como secreto', () =>
    rechaza(
      `Bearer ${new JwtService({ secret: par.publicKey }).sign(claims, {
        algorithm: 'HS256',
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        expiresIn: 900,
      })}`,
    ));

  it('rechaza un token con alg: none', () => {
    const token = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({
      ...claims,
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 900,
    })}.`;
    return rechaza(`Bearer ${token}`);
  });

  it('rechaza un emisor distinto', () =>
    rechaza(`Bearer ${firmar(claims, { issuer: 'otro' })}`));

  it('rechaza una audiencia distinta', () =>
    rechaza(`Bearer ${firmar(claims, { audience: 'otra' })}`));

  it('rechaza un token bien firmado con un rol desconocido', () =>
    rechaza(`Bearer ${firmar({ ...claims, rol: 'SUPERUSUARIO' })}`));

  it('rechaza un token bien firmado sin sub', () =>
    rechaza(`Bearer ${firmar({ rol: Role.ADMIN, sid: 's1' })}`));
});
