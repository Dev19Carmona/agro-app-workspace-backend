import {
  type ExecutionContext,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ServiceTokenGuard } from './service-token.guard.js';

const TOKEN = 's'.repeat(32);

const contextWith = (headers: Record<string, unknown>) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as unknown as ExecutionContext;

describe('ServiceTokenGuard', () => {
  const config = { get: vi.fn(() => TOKEN) };
  const guard = new ServiceTokenGuard(config as never);

  afterEach(() => vi.restoreAllMocks());

  it('deja pasar el token correcto', () => {
    expect(guard.canActivate(contextWith({ 'x-service-token': TOKEN }))).toBe(
      true,
    );
  });

  it('rechaza si el header falta', () => {
    expect(() => guard.canActivate(contextWith({}))).toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza un header vacío', () => {
    expect(() =>
      guard.canActivate(contextWith({ 'x-service-token': '' })),
    ).toThrow(UnauthorizedException);
  });

  it('rechaza un token distinto del mismo largo', () => {
    expect(() =>
      guard.canActivate(contextWith({ 'x-service-token': 'o'.repeat(32) })),
    ).toThrow(UnauthorizedException);
  });

  it('rechaza un token de otro largo', () => {
    expect(() =>
      guard.canActivate(contextWith({ 'x-service-token': 's'.repeat(31) })),
    ).toThrow(UnauthorizedException);
  });

  it('rechaza un header repetido, unido con coma o como lista', () => {
    expect(() =>
      guard.canActivate(
        contextWith({ 'x-service-token': `${TOKEN}, ${TOKEN}` }),
      ),
    ).toThrow(UnauthorizedException);
    expect(() =>
      guard.canActivate(contextWith({ 'x-service-token': [TOKEN, TOKEN] })),
    ).toThrow(UnauthorizedException);
  });

  it('el 401 no incluye detalle ni el token', () => {
    try {
      guard.canActivate(contextWith({ 'x-service-token': 'o'.repeat(32) }));
      expect.unreachable();
    } catch (error) {
      expect(
        JSON.stringify((error as UnauthorizedException).getResponse()),
      ).not.toContain(TOKEN);
    }
  });

  it('no registra el valor del token', () => {
    const spies = (['log', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(Logger.prototype, m).mockImplementation(() => {}),
    );
    const console_ = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      guard.canActivate(contextWith({ 'x-service-token': TOKEN }));
    } catch {}
    expect(spies.every((s) => !s.mock.calls.length)).toBe(true);
    expect(console_).not.toHaveBeenCalled();
  });
});
