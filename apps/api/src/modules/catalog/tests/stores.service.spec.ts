import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { StoresService } from '../services/stores.service.js';

const OWNER = new Types.ObjectId().toString();
const dto = { nombre: 'Agro Sur', nit: '900123', municipio: 'Pasto' };

function tienda(extra: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    ...dto,
    ownerId: new Types.ObjectId(OWNER),
    activa: true,
    createdAt: new Date('2026-11-07'),
    ...extra,
  };
}

describe('StoresService', () => {
  const create = vi.fn();
  const findOne = vi.fn();
  const find = vi.fn();
  const findById = vi.fn();
  const findByIdAndUpdate = vi.fn();
  const countDocuments = vi.fn();
  const model = {
    create,
    findOne,
    find,
    findById,
    findByIdAndUpdate,
    countDocuments,
  };
  const events = { emit: vi.fn() };
  let service: StoresService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new StoresService(model as never, events as never);
  });

  describe('create', () => {
    it('crea la tienda con el ownerId del token y la devuelve', async () => {
      const creada = tienda();
      create.mockResolvedValue(creada);

      const view = await service.create(OWNER, dto);

      expect(create).toHaveBeenCalledWith({ ...dto, ownerId: OWNER });
      expect(view).toMatchObject({
        id: creada._id.toString(),
        ownerId: OWNER,
        nombre: 'Agro Sur',
        activa: true,
      });
    });

    it('emite store.created con storeId y ownerId', async () => {
      const creada = tienda();
      create.mockResolvedValue(creada);

      await service.create(OWNER, dto);

      expect(events.emit).toHaveBeenCalledWith('store.created', {
        storeId: creada._id.toString(),
        ownerId: OWNER,
      });
    });

    it('traduce la clave duplicada (segunda tienda) a 409 sin emitir', async () => {
      create.mockRejectedValue({ code: 11000 });

      await expect(service.create(OWNER, dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('propaga cualquier otro error (no es un 409)', async () => {
      const fallo = new Error('conexión caída');
      create.mockRejectedValue(fallo);

      await expect(service.create(OWNER, dto)).rejects.toBe(fallo);
    });
  });

  describe('administración (ADMIN)', () => {
    const id = new Types.ObjectId().toString();

    it('listAdmin no filtra por activa y pagina', async () => {
      const chain = {
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: async () => [tienda({ activa: false })],
      };
      find.mockReturnValue(chain);
      countDocuments.mockResolvedValue(41);

      const page = await service.listAdmin({ page: 3, limit: 20 });

      expect(find).toHaveBeenCalledWith({});
      expect(chain.skip).toHaveBeenCalledWith(40);
      expect(chain.limit).toHaveBeenCalledWith(20);
      expect(page).toMatchObject({ total: 41, totalPages: 3, page: 3 });
      expect(page.data[0].activa).toBe(false);
    });

    it('listAdmin filtra por municipio', async () => {
      find.mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: async () => [],
      });
      countDocuments.mockResolvedValue(0);

      await service.listAdmin({ page: 1, limit: 20, municipio: 'Pasto' });

      expect(find).toHaveBeenCalledWith({ municipio: 'Pasto' });
    });

    it('findOneAdmin devuelve la tienda aunque esté desactivada', async () => {
      findById.mockReturnValue({ lean: async () => tienda({ activa: false }) });

      expect((await service.findOneAdmin(id)).activa).toBe(false);
    });

    it('findOneAdmin responde 404 si no existe', async () => {
      findById.mockReturnValue({ lean: async () => null });

      await expect(service.findOneAdmin(id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('updateAdmin solo setea los campos recibidos', async () => {
      findByIdAndUpdate.mockReturnValue({
        lean: async () => tienda({ nit: '777' }),
      });

      const view = await service.updateAdmin(id, { nit: '777' });

      expect(findByIdAndUpdate).toHaveBeenCalledWith(
        id,
        { $set: { nit: '777' } },
        { new: true },
      );
      expect(view.nit).toBe('777');
    });

    it('updateAdmin responde 404 si no existe', async () => {
      findByIdAndUpdate.mockReturnValue({ lean: async () => null });

      await expect(
        service.updateAdmin(id, { nit: '1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deactivate pone activa en false y es idempotente', async () => {
      findByIdAndUpdate.mockReturnValue({
        lean: async () => tienda({ activa: false }),
      });

      const primera = await service.deactivate(id);
      const segunda = await service.deactivate(id);

      expect(findByIdAndUpdate).toHaveBeenCalledWith(
        id,
        { $set: { activa: false } },
        { new: true },
      );
      expect(primera.activa).toBe(false);
      expect(segunda.activa).toBe(false);
    });

    it('deactivate responde 404 si no existe', async () => {
      findByIdAndUpdate.mockReturnValue({ lean: async () => null });

      await expect(service.deactivate(id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('getMine', () => {
    it('busca por ownerId y devuelve la tienda', async () => {
      findOne.mockReturnValue({ lean: async () => tienda() });

      const view = await service.getMine(OWNER);

      expect(findOne).toHaveBeenCalledWith({ ownerId: OWNER });
      expect(view.ownerId).toBe(OWNER);
    });

    it('responde 404 si el proveedor no tiene tienda', async () => {
      findOne.mockReturnValue({ lean: async () => null });

      await expect(service.getMine(OWNER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
