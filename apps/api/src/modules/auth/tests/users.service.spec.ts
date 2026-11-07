import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { Role } from '../../../../../../libs/common/src/security/roles.js';
import { AuthEvents } from '../events/auth.events.js';
import { UserStatus } from '../schemas/user.schema.js';
import { UsersService } from '../services/users.service.js';

function usuario(extra: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    email: 'vic@correo.com',
    nombre: 'Vic',
    documento: '9988776655',
    rol: Role.PROVEEDOR,
    status: UserStatus.PENDING_APPROVAL,
    createdAt: new Date('2026-11-06'),
    ...extra,
  };
}

describe('UsersService', () => {
  const adminId = new Types.ObjectId().toString();
  const find = vi.fn();
  const findById = vi.fn();
  const findOneAndUpdate = vi.fn();
  const exists = vi.fn();
  const countDocuments = vi.fn();
  const model = { find, findById, findOneAndUpdate, exists, countDocuments };
  const tokens = { revokeAllForUser: vi.fn() };
  const events = { emit: vi.fn() };
  let service: UsersService;

  const conLean = (valor: unknown) => ({ lean: async () => valor });

  beforeEach(() => {
    vi.resetAllMocks();
    service = new UsersService(
      model as never,
      tokens as never,
      events as never,
    );
  });

  describe('list', () => {
    it('pagina con skip/limit, ordena por más reciente y calcula totales', async () => {
      const chain = {
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([usuario(), usuario()]),
      };
      find.mockReturnValue(chain);
      countDocuments.mockResolvedValue(45);

      const r = await service.list({ page: 3, limit: 20 });

      expect(chain.skip).toHaveBeenCalledWith(40);
      expect(chain.limit).toHaveBeenCalledWith(20);
      expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
      expect(r).toMatchObject({
        page: 3,
        limit: 20,
        total: 45,
        totalPages: 3,
      });
      expect(r.data).toHaveLength(2);
    });

    it('aplica los filtros por rol y status, y solo esos', async () => {
      find.mockReturnValue({
        sort: () => ({
          skip: () => ({ limit: () => conLean([]) }),
        }),
      });
      countDocuments.mockResolvedValue(0);

      await service.list({
        page: 1,
        limit: 20,
        rol: Role.PROVEEDOR,
        status: UserStatus.PENDING_APPROVAL,
      });

      const filtro = { rol: 'PROVEEDOR', status: 'PENDING_APPROVAL' };
      expect(find).toHaveBeenCalledWith(filtro);
      expect(countDocuments).toHaveBeenCalledWith(filtro);
    });

    it('sin filtros consulta todo', async () => {
      find.mockReturnValue({
        sort: () => ({ skip: () => ({ limit: () => conLean([]) }) }),
      });
      countDocuments.mockResolvedValue(0);

      const r = await service.list({ page: 1, limit: 20 });

      expect(find).toHaveBeenCalledWith({});
      expect(r.totalPages).toBe(0);
    });

    it('la vista no incluye passwordHash aunque el documento lo traiga', async () => {
      find.mockReturnValue({
        sort: () => ({
          skip: () => ({
            limit: () => conLean([usuario({ passwordHash: 'secreto' })]),
          }),
        }),
      });
      countDocuments.mockResolvedValue(1);

      const r = await service.list({ page: 1, limit: 20 });
      expect(JSON.stringify(r)).not.toMatch(/passwordHash|secreto/);
    });
  });

  describe('findOne', () => {
    it('devuelve el detalle', async () => {
      const u = usuario();
      findById.mockReturnValue(conLean(u));

      await expect(service.findOne(u._id.toString())).resolves.toMatchObject({
        id: u._id.toString(),
        email: 'vic@correo.com',
        documento: '9988776655',
      });
    });

    it('404 si no existe', async () => {
      findById.mockReturnValue(conLean(null));
      await expect(service.findOne('x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('approve', () => {
    it('aprueba a un PROVEEDOR pendiente: ACTIVE, reviewedBy/At y evento', async () => {
      const u = usuario({ status: UserStatus.ACTIVE });
      findOneAndUpdate.mockReturnValue(conLean(u));
      const id = u._id.toString();

      const r = await service.approve(id, adminId);

      const [filtro, cambio] = findOneAndUpdate.mock.calls[0];
      expect(filtro).toEqual({
        _id: id,
        rol: Role.PROVEEDOR,
        status: UserStatus.PENDING_APPROVAL,
      });
      expect(cambio.$set.status).toBe(UserStatus.ACTIVE);
      expect(cambio.$set.reviewedBy.toString()).toBe(adminId);
      expect(cambio.$set.reviewedAt).toBeInstanceOf(Date);
      expect(cambio.$unset).toEqual({ rejectionReason: 1 });
      expect(r.status).toBe(UserStatus.ACTIVE);
      expect(events.emit).toHaveBeenCalledWith(AuthEvents.ProviderApproved, {
        userId: id,
        email: 'vic@correo.com',
        reviewedBy: adminId,
      });
    });

    it('409 si no es un PROVEEDOR pendiente y no emite evento', async () => {
      findOneAndUpdate.mockReturnValue(conLean(null));
      exists.mockResolvedValue({ _id: 'x' });

      await expect(service.approve('x', adminId)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('404 si el usuario no existe', async () => {
      findOneAndUpdate.mockReturnValue(conLean(null));
      exists.mockResolvedValue(null);

      await expect(service.approve('x', adminId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('reject', () => {
    it('rechaza con motivo: REJECTED, rejectionReason, reviewedBy/At y evento', async () => {
      const u = usuario({ status: UserStatus.REJECTED });
      findOneAndUpdate.mockReturnValue(conLean(u));
      const id = u._id.toString();

      await service.reject(id, adminId, 'Documento ilegible');

      const [filtro, cambio] = findOneAndUpdate.mock.calls[0];
      expect(filtro).toEqual({
        _id: id,
        rol: Role.PROVEEDOR,
        status: UserStatus.PENDING_APPROVAL,
      });
      expect(cambio.$set).toMatchObject({
        status: UserStatus.REJECTED,
        rejectionReason: 'Documento ilegible',
      });
      expect(cambio.$set.reviewedBy.toString()).toBe(adminId);
      expect(events.emit).toHaveBeenCalledWith(AuthEvents.ProviderRejected, {
        userId: id,
        email: 'vic@correo.com',
        reviewedBy: adminId,
        reason: 'Documento ilegible',
      });
    });

    it('sin motivo no escribe rejectionReason ni lo incluye en el evento', async () => {
      findOneAndUpdate.mockReturnValue(conLean(usuario()));

      await service.reject('x', adminId);

      expect(findOneAndUpdate.mock.calls[0][1].$set).not.toHaveProperty(
        'rejectionReason',
      );
      expect(events.emit.mock.calls[0][1]).not.toHaveProperty('reason');
    });

    it('409 si no es un PROVEEDOR pendiente', async () => {
      findOneAndUpdate.mockReturnValue(conLean(null));
      exists.mockResolvedValue({ _id: 'x' });

      await expect(service.reject('x', adminId)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('disable', () => {
    it('pasa ACTIVE a DISABLED y revoca todos sus refresh tokens', async () => {
      const u = usuario({ status: UserStatus.DISABLED });
      findOneAndUpdate.mockReturnValue(conLean(u));
      const id = u._id.toString();

      const r = await service.disable(id, adminId);

      expect(findOneAndUpdate.mock.calls[0][0]).toEqual({
        _id: id,
        status: UserStatus.ACTIVE,
      });
      expect(r.status).toBe(UserStatus.DISABLED);
      expect(tokens.revokeAllForUser).toHaveBeenCalledWith(id);
    });

    it('un ADMIN no puede deshabilitarse a sí mismo (403) y no toca la base', async () => {
      await expect(service.disable(adminId, adminId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(findOneAndUpdate).not.toHaveBeenCalled();
      expect(tokens.revokeAllForUser).not.toHaveBeenCalled();
    });

    it('409 si el usuario no está activo y no revoca nada', async () => {
      findOneAndUpdate.mockReturnValue(conLean(null));
      exists.mockResolvedValue({ _id: 'x' });

      await expect(service.disable('x', adminId)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(tokens.revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  describe('enable', () => {
    it('pasa DISABLED a ACTIVE', async () => {
      const u = usuario({ status: UserStatus.ACTIVE });
      findOneAndUpdate.mockReturnValue(conLean(u));

      const r = await service.enable(u._id.toString());

      expect(findOneAndUpdate.mock.calls[0][0]).toMatchObject({
        status: UserStatus.DISABLED,
      });
      expect(r.status).toBe(UserStatus.ACTIVE);
    });

    it('409 si no estaba deshabilitado', async () => {
      findOneAndUpdate.mockReturnValue(conLean(null));
      exists.mockResolvedValue({ _id: 'x' });

      await expect(service.enable('x')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('changeRole', () => {
    it('cambia el rol y revoca todos los refresh tokens del usuario', async () => {
      const actual = usuario({
        rol: Role.PRODUCTOR,
        status: UserStatus.ACTIVE,
      });
      const id = actual._id.toString();
      findById.mockReturnValue(conLean(actual));
      findOneAndUpdate.mockReturnValue(conLean({ ...actual, rol: Role.ADMIN }));

      const r = await service.changeRole(id, adminId, Role.ADMIN);

      const [filtro, cambio] = findOneAndUpdate.mock.calls[0];
      expect(filtro).toEqual({
        _id: id,
        status: { $in: [UserStatus.ACTIVE, UserStatus.DISABLED] },
      });
      expect(cambio).toEqual({ $set: { rol: Role.ADMIN } });
      expect(r.rol).toBe(Role.ADMIN);
      expect(tokens.revokeAllForUser).toHaveBeenCalledWith(id);
    });

    it('un ADMIN no puede cambiarse el rol a sí mismo (403)', async () => {
      await expect(
        service.changeRole(adminId, adminId, Role.PRODUCTOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(findById).not.toHaveBeenCalled();
      expect(tokens.revokeAllForUser).not.toHaveBeenCalled();
    });

    it('si el rol ya es ese no cambia nada ni revoca sesiones', async () => {
      const actual = usuario({
        rol: Role.PRODUCTOR,
        status: UserStatus.ACTIVE,
      });
      findById.mockReturnValue(conLean(actual));

      await service.changeRole(actual._id.toString(), adminId, Role.PRODUCTOR);

      expect(findOneAndUpdate).not.toHaveBeenCalled();
      expect(tokens.revokeAllForUser).not.toHaveBeenCalled();
    });

    it('404 si no existe', async () => {
      findById.mockReturnValue(conLean(null));

      await expect(
        service.changeRole('x', adminId, Role.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('409 si el usuario está pendiente o rechazado (flujo de aprobación)', async () => {
      findById.mockReturnValue(conLean(usuario({ rol: Role.PROVEEDOR })));
      findOneAndUpdate.mockReturnValue(conLean(null));
      exists.mockResolvedValue({ _id: 'x' });

      await expect(
        service.changeRole('x', adminId, Role.PRODUCTOR),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tokens.revokeAllForUser).not.toHaveBeenCalled();
    });
  });
});
