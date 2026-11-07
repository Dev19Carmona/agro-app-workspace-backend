import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { Role } from '../../../../../../libs/common/src/security/roles.js';
import { AuthEvents } from '../events/auth.events.js';
import {
  AuthService,
  CONSENT_VERSION,
  LOCK_DURATION_MS,
} from '../services/auth.service.js';
import type { RegisterDto } from '../dto/register.dto.js';
import { UserStatus } from '../schemas/user.schema.js';

const registro: RegisterDto = {
  email: 'ana@correo.com',
  password: 'Segura12345',
  nombre: 'Ana',
  documento: '1020304050',
  rol: Role.PRODUCTOR,
  aceptaTratamientoDatos: true,
};

function usuarioGuardado(extra: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    email: 'ana@correo.com',
    passwordHash: 'hash-guardado',
    nombre: 'Ana',
    documento: '1020304050',
    rol: Role.PRODUCTOR,
    status: UserStatus.ACTIVE,
    failedLoginAttempts: 0,
    ...extra,
  };
}

describe('AuthService', () => {
  const create = vi.fn();
  const findOne = vi.fn();
  const findOneAndUpdate = vi.fn();
  const updateOne = vi.fn();
  const findById = vi.fn();
  const userModel = {
    create,
    findOne,
    findOneAndUpdate,
    updateOne,
    findById,
  };
  const passwords = {
    assertPolicy: vi.fn(),
    hash: vi.fn(),
    compare: vi.fn(),
  };
  const tokens = {
    startSession: vi.fn(),
    signAccessToken: vi.fn(),
    rotate: vi.fn(),
    revokeFamily: vi.fn(),
    revokeAllForUser: vi.fn(),
  };
  const events = { emit: vi.fn() };
  let service: AuthService;

  const encontrar = (usuario: unknown) =>
    findOne.mockReturnValue({
      select: () => ({ lean: async () => usuario }),
    });

  beforeEach(() => {
    vi.resetAllMocks();
    passwords.hash.mockResolvedValue('hash-nuevo');
    tokens.startSession.mockResolvedValue({
      token: 'refresh-claro',
      familyId: 'fam-1',
      expiresAt: new Date(),
    });
    tokens.signAccessToken.mockResolvedValue('access-jwt');
    service = new AuthService(
      userModel as never,
      passwords as never,
      tokens as never,
      events as never,
    );
  });

  describe('register', () => {
    beforeEach(() => {
      create.mockImplementation(async (data: Record<string, unknown>) => ({
        _id: new Types.ObjectId(),
        ...data,
      }));
    });

    it('PRODUCTOR queda ACTIVE y la respuesta no trae hash ni documento', async () => {
      const r = await service.register(registro);

      expect(r).toMatchObject({
        email: 'ana@correo.com',
        rol: Role.PRODUCTOR,
        status: UserStatus.ACTIVE,
      });
      expect(JSON.stringify(r)).not.toMatch(
        /passwordHash|hash-nuevo|1020304050/,
      );
    });

    it('PROVEEDOR queda PENDING_APPROVAL', async () => {
      const r = await service.register({ ...registro, rol: Role.PROVEEDOR });
      expect(r.status).toBe(UserStatus.PENDING_APPROVAL);
    });

    it('valida la política con el email, guarda el hash y el consentimiento con fecha', async () => {
      await service.register(registro);

      expect(passwords.assertPolicy).toHaveBeenCalledWith(
        'Segura12345',
        'ana@correo.com',
      );
      const guardado = create.mock.calls[0][0];
      expect(guardado.passwordHash).toBe('hash-nuevo');
      expect(guardado).not.toHaveProperty('password');
      expect(guardado.consent.acceptedAt).toBeInstanceOf(Date);
      expect(guardado.consent.version).toBe(CONSENT_VERSION);
    });

    it('emite user.registered sin datos sensibles', async () => {
      const r = await service.register(registro);

      expect(events.emit).toHaveBeenCalledWith(AuthEvents.UserRegistered, {
        userId: r.id,
        email: 'ana@correo.com',
        rol: Role.PRODUCTOR,
        status: UserStatus.ACTIVE,
      });
    });

    it('una contraseña que incumple la política da 400 y no crea nada', async () => {
      passwords.assertPolicy.mockImplementation(() => {
        throw new BadRequestException(['débil']);
      });

      await expect(service.register(registro)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(create).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('clave duplicada de Mongo (11000) responde 409, no 500', async () => {
      create.mockRejectedValue(
        Object.assign(new Error('E11000 duplicate key'), { code: 11000 }),
      );

      await expect(service.register(registro)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('otros errores de Mongo se propagan', async () => {
      const error = new Error('conexión caída');
      create.mockRejectedValue(error);

      await expect(service.register(registro)).rejects.toBe(error);
    });
  });

  describe('login', () => {
    const dto = { email: 'ana@correo.com', password: 'Segura12345' };

    it('email inexistente: 401 y compara contra hash falso (hash undefined)', async () => {
      encontrar(null);
      passwords.compare.mockResolvedValue(false);

      await expect(service.login(dto)).rejects.toEqual(
        new UnauthorizedException('Credenciales inválidas'),
      );
      expect(passwords.compare).toHaveBeenCalledWith('Segura12345', undefined);
    });

    it('contraseña incorrecta y email inexistente dan exactamente el mismo error', async () => {
      encontrar(null);
      passwords.compare.mockResolvedValue(false);
      const inexistente = await service.login(dto).catch((e) => e);

      encontrar(usuarioGuardado());
      findOneAndUpdate.mockResolvedValue({ failedLoginAttempts: 1 });
      const incorrecta = await service.login(dto).catch((e) => e);

      expect(incorrecta.getStatus()).toBe(inexistente.getStatus());
      expect(incorrecta.getResponse()).toEqual(inexistente.getResponse());
    });

    it('login correcto devuelve tokens, con sid = familia y sin hash', async () => {
      const usuario = usuarioGuardado({ storeId: new Types.ObjectId() });
      encontrar(usuario);
      passwords.compare.mockResolvedValue(true);

      const r = await service.login(dto);

      expect(r).toMatchObject({
        accessToken: 'access-jwt',
        refreshToken: 'refresh-claro',
        tokenType: 'Bearer',
        expiresIn: 900,
      });
      expect(tokens.signAccessToken).toHaveBeenCalledWith({
        userId: usuario._id.toString(),
        rol: Role.PRODUCTOR,
        sessionId: 'fam-1',
        storeId: usuario.storeId.toString(),
      });
      expect(JSON.stringify(r)).not.toMatch(/passwordHash|hash-guardado/);
    });

    it('un fallo incrementa el contador y no bloquea antes de 5', async () => {
      encontrar(usuarioGuardado({ failedLoginAttempts: 3 }));
      passwords.compare.mockResolvedValue(false);
      findOneAndUpdate.mockResolvedValue({ failedLoginAttempts: 4 });

      await expect(service.login(dto)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(findOneAndUpdate.mock.calls[0][1]).toEqual({
        $inc: { failedLoginAttempts: 1 },
      });
      expect(updateOne).not.toHaveBeenCalled();
    });

    it('el 5.º fallo bloquea la cuenta 15 min', async () => {
      encontrar(usuarioGuardado({ failedLoginAttempts: 4 }));
      passwords.compare.mockResolvedValue(false);
      findOneAndUpdate.mockResolvedValue({ failedLoginAttempts: 5 });
      const antes = Date.now();

      await expect(service.login(dto)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );

      const { lockedUntil } = updateOne.mock.calls[0][1].$set;
      expect(lockedUntil.getTime() - antes).toBeGreaterThanOrEqual(
        LOCK_DURATION_MS,
      );
      expect(lockedUntil.getTime() - antes).toBeLessThan(
        LOCK_DURATION_MS + 5000,
      );
      expect(LOCK_DURATION_MS).toBe(15 * 60 * 1000);
    });

    it('cuenta bloqueada con contraseña correcta: 401, sin tokens y sin contar intento', async () => {
      encontrar(
        usuarioGuardado({
          failedLoginAttempts: 5,
          lockedUntil: new Date(Date.now() + 60_000),
        }),
      );
      passwords.compare.mockResolvedValue(true);

      await expect(service.login(dto)).rejects.toEqual(
        new UnauthorizedException('Credenciales inválidas'),
      );
      expect(passwords.compare).toHaveBeenCalled(); // mismo costo que sin bloqueo
      expect(tokens.startSession).not.toHaveBeenCalled();
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('bloqueo vencido + contraseña correcta: entra y reinicia el contador', async () => {
      const usuario = usuarioGuardado({
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() - 1000),
      });
      encontrar(usuario);
      passwords.compare.mockResolvedValue(true);

      await expect(service.login(dto)).resolves.toMatchObject({
        accessToken: 'access-jwt',
      });
      expect(updateOne).toHaveBeenCalledWith(
        { _id: usuario._id },
        { $set: { failedLoginAttempts: 0 }, $unset: { lockedUntil: 1 } },
      );
    });

    it('bloqueo vencido + contraseña incorrecta: el conteo reinicia en 1, no bloquea de nuevo', async () => {
      const usuario = usuarioGuardado({
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() - 1000),
      });
      encontrar(usuario);
      passwords.compare.mockResolvedValue(false);

      await expect(service.login(dto)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(updateOne).toHaveBeenCalledWith(
        { _id: usuario._id },
        { $set: { failedLoginAttempts: 1 }, $unset: { lockedUntil: 1 } },
      );
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('login correcto con intentos previos los pone en 0', async () => {
      const usuario = usuarioGuardado({ failedLoginAttempts: 2 });
      encontrar(usuario);
      passwords.compare.mockResolvedValue(true);

      await service.login(dto);

      expect(updateOne).toHaveBeenCalledWith(
        { _id: usuario._id },
        { $set: { failedLoginAttempts: 0 }, $unset: { lockedUntil: 1 } },
      );
    });

    it('login correcto sin intentos previos no escribe en la base', async () => {
      encontrar(usuarioGuardado());
      passwords.compare.mockResolvedValue(true);

      await service.login(dto);
      expect(updateOne).not.toHaveBeenCalled();
    });

    it.each([
      [UserStatus.PENDING_APPROVAL, /pendiente/],
      [UserStatus.REJECTED, /rechazada/],
      [UserStatus.DISABLED, /deshabilitada/],
    ])(
      '%s con contraseña correcta: 403 y no emite tokens',
      async (status, mensaje) => {
        encontrar(usuarioGuardado({ status }));
        passwords.compare.mockResolvedValue(true);

        const error = await service.login(dto).catch((e) => e);

        expect(error).toBeInstanceOf(ForbiddenException);
        expect(error.message).toMatch(mensaje);
        expect(tokens.startSession).not.toHaveBeenCalled();
        expect(tokens.signAccessToken).not.toHaveBeenCalled();
      },
    );

    it.each([
      UserStatus.PENDING_APPROVAL,
      UserStatus.REJECTED,
      UserStatus.DISABLED,
    ])(
      '%s con contraseña incorrecta: 401, el estado no se filtra',
      async (status) => {
        encontrar(usuarioGuardado({ status }));
        passwords.compare.mockResolvedValue(false);
        findOneAndUpdate.mockResolvedValue({ failedLoginAttempts: 1 });

        await expect(service.login(dto)).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      },
    );

    it('consulta Mongo solo con el email (string) del DTO', async () => {
      encontrar(null);
      passwords.compare.mockResolvedValue(false);

      await service.login(dto).catch(() => undefined);
      expect(findOne).toHaveBeenCalledWith({ email: 'ana@correo.com' });
    });
  });

  describe('sesión', () => {
    const usuario = usuarioGuardado({ storeId: new Types.ObjectId() });
    const userId = usuario._id.toString();

    const buscarPorId = (u: unknown) =>
      findById.mockReturnValue({
        lean: async () => u,
        select: () => ({ lean: async () => u }),
      });

    describe('refresh', () => {
      beforeEach(() => {
        tokens.rotate.mockResolvedValue({
          token: 'refresh-nuevo',
          expiresAt: new Date(),
          userId,
          familyId: 'fam-1',
        });
      });

      it('devuelve un par nuevo con el rol y la tienda actuales del usuario', async () => {
        buscarPorId(usuario);

        const r = await service.refresh({ refreshToken: 'viejo' });

        expect(tokens.rotate).toHaveBeenCalledWith('viejo');
        expect(r).toMatchObject({
          accessToken: 'access-jwt',
          refreshToken: 'refresh-nuevo',
          expiresIn: 900,
        });
        expect(tokens.signAccessToken).toHaveBeenCalledWith({
          userId,
          rol: Role.PRODUCTOR,
          sessionId: 'fam-1',
          storeId: usuario.storeId.toString(),
        });
      });

      it('propaga el 401 de un refresh reutilizado o inválido', async () => {
        tokens.rotate.mockRejectedValue(new UnauthorizedException());

        await expect(
          service.refresh({ refreshToken: 'viejo' }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(findById).not.toHaveBeenCalled();
      });

      it.each([UserStatus.DISABLED, UserStatus.REJECTED])(
        'usuario %s: 401 y cierra la sesión',
        async (status) => {
          buscarPorId(usuarioGuardado({ status }));

          await expect(
            service.refresh({ refreshToken: 'viejo' }),
          ).rejects.toBeInstanceOf(UnauthorizedException);
          expect(tokens.revokeFamily).toHaveBeenCalledWith('fam-1');
          expect(tokens.signAccessToken).not.toHaveBeenCalled();
        },
      );

      it('usuario inexistente: 401 y cierra la sesión', async () => {
        buscarPorId(null);

        await expect(
          service.refresh({ refreshToken: 'viejo' }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(tokens.revokeFamily).toHaveBeenCalledWith('fam-1');
      });
    });

    describe('logout', () => {
      it('revoca la familia de la sesión actual', async () => {
        await service.logout('fam-1');
        expect(tokens.revokeFamily).toHaveBeenCalledWith('fam-1');
        expect(tokens.revokeAllForUser).not.toHaveBeenCalled();
      });
    });

    describe('getProfile', () => {
      it('devuelve el perfil sin hash ni documento, con storeId', async () => {
        buscarPorId(usuario);

        const perfil = await service.getProfile(userId);

        expect(perfil).toEqual({
          id: userId,
          email: 'ana@correo.com',
          nombre: 'Ana',
          rol: Role.PRODUCTOR,
          status: UserStatus.ACTIVE,
          storeId: usuario.storeId.toString(),
        });
        expect(JSON.stringify(perfil)).not.toMatch(/hash|1020304050/);
      });

      it('omite storeId si aún no tiene tienda', async () => {
        buscarPorId(usuarioGuardado());
        expect(await service.getProfile(userId)).not.toHaveProperty('storeId');
      });

      it('usuario inexistente: 401', async () => {
        buscarPorId(null);
        await expect(service.getProfile(userId)).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      });
    });

    describe('changePassword', () => {
      const dto = {
        currentPassword: 'Actual12345',
        newPassword: 'Nueva123456',
      };

      beforeEach(() => {
        buscarPorId(usuario);
        passwords.compare.mockResolvedValue(true);
      });

      it('con la actual correcta guarda el hash nuevo, fija passwordChangedAt y revoca todas las sesiones', async () => {
        await service.changePassword(userId, dto);

        expect(passwords.compare).toHaveBeenCalledWith(
          'Actual12345',
          'hash-guardado',
        );
        expect(passwords.assertPolicy).toHaveBeenCalledWith(
          'Nueva123456',
          'ana@correo.com',
        );
        const [filtro, cambio] = updateOne.mock.calls[0];
        expect(filtro).toEqual({ _id: usuario._id });
        expect(cambio.$set.passwordHash).toBe('hash-nuevo');
        expect(cambio.$set.passwordChangedAt).toBeInstanceOf(Date);
        expect(tokens.revokeAllForUser).toHaveBeenCalledWith(userId);
      });

      it('con la actual errónea: 401, sin cambios ni revocaciones', async () => {
        passwords.compare.mockResolvedValue(false);

        await expect(
          service.changePassword(userId, dto),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(updateOne).not.toHaveBeenCalled();
        expect(tokens.revokeAllForUser).not.toHaveBeenCalled();
      });

      it('usuario inexistente: 401', async () => {
        buscarPorId(null);
        passwords.compare.mockResolvedValue(false);

        await expect(
          service.changePassword(userId, dto),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      });

      it('una nueva contraseña que incumple la política da 400 y no cambia nada', async () => {
        passwords.assertPolicy.mockImplementation(() => {
          throw new BadRequestException(['débil']);
        });

        await expect(
          service.changePassword(userId, { ...dto, newPassword: 'abc' }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(updateOne).not.toHaveBeenCalled();
        expect(tokens.revokeAllForUser).not.toHaveBeenCalled();
      });

      it('la política se evalúa después de validar la actual', async () => {
        passwords.compare.mockResolvedValue(false);

        await service.changePassword(userId, dto).catch(() => undefined);
        expect(passwords.assertPolicy).not.toHaveBeenCalled();
      });
    });
  });
});
