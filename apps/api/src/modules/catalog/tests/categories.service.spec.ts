import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { CategoriesService } from '../services/categories.service.js';

const categoria = (extra: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  nombre: 'Semillas',
  activa: true,
  ...extra,
});

describe('CategoriesService', () => {
  const create = vi.fn();
  const findByIdAndUpdate = vi.fn();
  let service: CategoriesService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new CategoriesService({ create, findByIdAndUpdate } as never);
  });

  describe('create', () => {
    it('crea la categoría y devuelve su vista', async () => {
      const creada = categoria();
      create.mockResolvedValue(creada);

      const view = await service.create({ nombre: 'Semillas' });

      expect(create).toHaveBeenCalledWith({ nombre: 'Semillas' });
      expect(view).toEqual({
        id: creada._id.toString(),
        nombre: 'Semillas',
        activa: true,
      });
    });

    it('traduce un nombre repetido (11000) a 409', async () => {
      create.mockRejectedValue({ code: 11000 });

      await expect(
        service.create({ nombre: 'Semillas' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('propaga otros errores', async () => {
      const fallo = new Error('conexión caída');
      create.mockRejectedValue(fallo);

      await expect(service.create({ nombre: 'X' })).rejects.toBe(fallo);
    });
  });

  describe('update', () => {
    const id = new Types.ObjectId().toString();

    it('actualiza nombre y activa', async () => {
      findByIdAndUpdate.mockReturnValue({
        lean: async () => categoria({ activa: false }),
      });

      const view = await service.update(id, { activa: false });

      expect(findByIdAndUpdate).toHaveBeenCalledWith(
        id,
        { $set: { activa: false } },
        { new: true },
      );
      expect(view.activa).toBe(false);
    });

    it('responde 404 si la categoría no existe', async () => {
      findByIdAndUpdate.mockReturnValue({ lean: async () => null });

      await expect(service.update(id, { nombre: 'X' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('traduce un nombre repetido (11000) a 409', async () => {
      findByIdAndUpdate.mockReturnValue({
        lean: async () => {
          throw { code: 11000 };
        },
      });

      await expect(service.update(id, { nombre: 'X' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});
