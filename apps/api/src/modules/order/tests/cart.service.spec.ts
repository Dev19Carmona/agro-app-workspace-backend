import { BadRequestException, ConflictException } from '@nestjs/common';
import { CartService } from '../services/cart.service.js';

const BUYER = '6aee7a351616d80ba08c95aa';
const VARIANT = 'b'.repeat(24);
const CART_ID = 'c'.repeat(24);

const variante = (apta = true) => ({
  variantId: VARIANT,
  productId: 'p1',
  storeId: 's1',
  nombreProducto: 'Herbicida',
  presentacion: '4 L',
  unidad: 'L',
  precioVigente: 1000,
  disponible: 5,
  apta,
});

/** Encadena `.lean()` como lo hace Mongoose. */
const lean = <T>(value: T) => ({ lean: () => Promise.resolve(value) });

describe('CartService', () => {
  const cartModel = { findOne: vi.fn(), findOneAndUpdate: vi.fn() };
  const itemModel = {
    find: vi.fn(),
    exists: vi.fn(),
    countDocuments: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
    deleteMany: vi.fn(),
  };
  const catalog = { getCheckoutVariants: vi.fn() };
  let service: CartService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new CartService(
      cartModel as never,
      itemModel as never,
      catalog as never,
    );
    cartModel.findOneAndUpdate.mockReturnValue(lean({ _id: CART_ID }));
    itemModel.exists.mockResolvedValue(null);
    itemModel.countDocuments.mockResolvedValue(0);
    itemModel.findOneAndUpdate.mockResolvedValue(null);
  });

  describe('setItem', () => {
    it('crea el carrito y la línea con la cantidad absoluta', async () => {
      catalog.getCheckoutVariants.mockResolvedValue([variante()]);

      const result = await service.setItem(BUYER, VARIANT, 3);

      expect(result).toEqual({ variantId: VARIANT, cantidad: 3 });
      expect(cartModel.findOneAndUpdate).toHaveBeenCalledWith(
        { buyerId: BUYER },
        { $setOnInsert: { buyerId: BUYER } },
        { upsert: true, returnDocument: 'after' },
      );
      expect(itemModel.findOneAndUpdate).toHaveBeenCalledWith(
        { cartId: CART_ID, variantId: VARIANT },
        { $set: { cantidad: 3 } },
        { upsert: true },
      );
    });

    it('la misma cantidad dos veces es un upsert, no suma', async () => {
      catalog.getCheckoutVariants.mockResolvedValue([variante()]);

      await service.setItem(BUYER, VARIANT, 2);
      await service.setItem(BUYER, VARIANT, 2);

      expect(itemModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
      for (const call of itemModel.findOneAndUpdate.mock.calls) {
        expect(call[1]).toEqual({ $set: { cantidad: 2 } });
      }
    });

    it('400 si la variante no existe', async () => {
      catalog.getCheckoutVariants.mockResolvedValue([]);

      await expect(service.setItem(BUYER, VARIANT, 1)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(cartModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('400 si la variante no es apta (inactiva o requiresQuote)', async () => {
      catalog.getCheckoutVariants.mockResolvedValue([variante(false)]);

      await expect(service.setItem(BUYER, VARIANT, 1)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(itemModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('400 en la línea 51 si la variante es nueva', async () => {
      catalog.getCheckoutVariants.mockResolvedValue([variante()]);
      itemModel.countDocuments.mockResolvedValue(50);

      await expect(service.setItem(BUYER, VARIANT, 1)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(itemModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('con 50 líneas permite cambiar la cantidad de una existente', async () => {
      catalog.getCheckoutVariants.mockResolvedValue([variante()]);
      itemModel.exists.mockResolvedValue({ _id: 'x' });
      itemModel.countDocuments.mockResolvedValue(50);

      await service.setItem(BUYER, VARIANT, 9);

      expect(itemModel.findOneAndUpdate).toHaveBeenCalled();
    });

    it('permite la línea 50', async () => {
      catalog.getCheckoutVariants.mockResolvedValue([variante()]);
      itemModel.countDocuments.mockResolvedValue(49);

      await service.setItem(BUYER, VARIANT, 1);

      expect(itemModel.findOneAndUpdate).toHaveBeenCalled();
    });

    it('si el upsert del carrito choca (11000) relee el carrito', async () => {
      catalog.getCheckoutVariants.mockResolvedValue([variante()]);
      cartModel.findOneAndUpdate.mockReturnValue({
        lean: () => Promise.reject({ code: 11000 }),
      });
      cartModel.findOne.mockReturnValue(lean({ _id: CART_ID }));

      await service.setItem(BUYER, VARIANT, 1);

      expect(itemModel.findOneAndUpdate).toHaveBeenCalledWith(
        { cartId: CART_ID, variantId: VARIANT },
        expect.anything(),
        expect.anything(),
      );
    });

    it('409 si la línea choca por clave duplicada', async () => {
      catalog.getCheckoutVariants.mockResolvedValue([variante()]);
      itemModel.findOneAndUpdate.mockRejectedValue({ code: 11000 });

      await expect(service.setItem(BUYER, VARIANT, 1)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('propaga errores que no son de clave duplicada', async () => {
      catalog.getCheckoutVariants.mockResolvedValue([variante()]);
      itemModel.findOneAndUpdate.mockRejectedValue(new Error('boom'));

      await expect(service.setItem(BUYER, VARIANT, 1)).rejects.toThrow('boom');
    });
  });

  describe('get', () => {
    const VARIANT_2 = 'd'.repeat(24);
    const lineas = (...l: { variantId: string; cantidad: number }[]) => {
      itemModel.find.mockReturnValue({
        sort: () => lean(l),
      });
    };

    it('sin carrito devuelve la lista vacía', async () => {
      cartModel.findOne.mockReturnValue(lean(null));

      await expect(service.get(BUYER)).resolves.toEqual({
        items: [],
        total: 0,
      });
      expect(catalog.getCheckoutVariants).not.toHaveBeenCalled();
    });

    it('devuelve precio vigente, disponible y apta del catálogo', async () => {
      cartModel.findOne.mockReturnValue(lean({ _id: CART_ID }));
      lineas({ variantId: VARIANT as never, cantidad: 3 });
      catalog.getCheckoutVariants.mockResolvedValue([
        { ...variante(), precioVigente: 800, disponible: 7 },
      ]);

      const result = await service.get(BUYER);

      expect(catalog.getCheckoutVariants).toHaveBeenCalledWith([VARIANT]);
      expect(result.items).toEqual([
        expect.objectContaining({
          variantId: VARIANT,
          cantidad: 3,
          precioVigente: 800,
          disponible: 7,
          apta: true,
        }),
      ]);
      expect(result.total).toBe(2400);
    });

    it('una variante que dejó de ser apta sale con apta false y no suma al total', async () => {
      cartModel.findOne.mockReturnValue(lean({ _id: CART_ID }));
      lineas(
        { variantId: VARIANT as never, cantidad: 2 },
        { variantId: VARIANT_2 as never, cantidad: 1 },
      );
      catalog.getCheckoutVariants.mockResolvedValue([
        variante(),
        { ...variante(false), variantId: VARIANT_2, precioVigente: 500 },
      ]);

      const result = await service.get(BUYER);

      expect(result.items.map((i) => i.apta)).toEqual([true, false]);
      expect(result.total).toBe(2000);
    });

    it('una variante que ya no existe sale con apta false y disponible 0', async () => {
      cartModel.findOne.mockReturnValue(lean({ _id: CART_ID }));
      lineas({ variantId: VARIANT as never, cantidad: 4 });
      catalog.getCheckoutVariants.mockResolvedValue([]);

      const result = await service.get(BUYER);

      expect(result.items).toEqual([
        { variantId: VARIANT, cantidad: 4, disponible: 0, apta: false },
      ]);
      expect(result.total).toBe(0);
    });
  });

  describe('removeItem', () => {
    it('borra la línea del carrito del comprador', async () => {
      cartModel.findOne.mockReturnValue(lean({ _id: CART_ID }));

      await service.removeItem(BUYER, VARIANT);

      expect(itemModel.deleteOne).toHaveBeenCalledWith({
        cartId: CART_ID,
        variantId: VARIANT,
      });
    });

    it('es idempotente: sin carrito no hace nada ni falla', async () => {
      cartModel.findOne.mockReturnValue(lean(null));

      await expect(service.removeItem(BUYER, VARIANT)).resolves.toBeUndefined();
      expect(itemModel.deleteOne).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('borra todas las líneas del carrito', async () => {
      cartModel.findOne.mockReturnValue(lean({ _id: CART_ID }));

      await service.clear(BUYER);

      expect(itemModel.deleteMany).toHaveBeenCalledWith({ cartId: CART_ID });
    });

    it('sin carrito no hace nada', async () => {
      cartModel.findOne.mockReturnValue(lean(null));

      await service.clear(BUYER);

      expect(itemModel.deleteMany).not.toHaveBeenCalled();
    });
  });
});
