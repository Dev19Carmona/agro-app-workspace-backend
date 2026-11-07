import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { ProductsService } from '../services/products.service.js';

const oid = () => new Types.ObjectId();
const OWNER = oid().toString();
const STORE_ID = oid();
const CATEGORY = oid().toString();
const PRODUCT_ID = oid();

const tienda = (extra: Record<string, unknown> = {}) => ({
  _id: STORE_ID,
  ownerId: OWNER,
  activa: true,
  ...extra,
});
const producto = (extra: Record<string, unknown> = {}) => ({
  _id: PRODUCT_ID,
  storeId: STORE_ID,
  categoryId: new Types.ObjectId(CATEGORY),
  nombre: 'Herbicida',
  marca: 'Agro',
  fichaTecnica: {},
  requiresQuote: false,
  activo: true,
  ...extra,
});
const variante = (extra: Record<string, unknown> = {}) => ({
  _id: oid(),
  productId: PRODUCT_ID,
  presentacion: '4 L',
  unidad: 'L',
  precio: 1000,
  stock: 10,
  stockReservado: 3,
  activo: true,
  ...extra,
});
const lean = (valor: unknown) => ({ lean: async () => valor });

describe('ProductsService', () => {
  const storeFindOne = vi.fn();
  const categoryExists = vi.fn();
  const productCreate = vi.fn();
  const productExists = vi.fn();
  const productFindOneAndUpdate = vi.fn();
  const variantCreate = vi.fn();
  const variantFindById = vi.fn();
  const variantFindByIdAndUpdate = vi.fn();
  let service: ProductsService;

  const dtoProducto = {
    categoryId: CATEGORY,
    nombre: 'Herbicida',
    marca: 'Agro',
    fichaTecnica: {},
  };

  beforeEach(() => {
    vi.resetAllMocks();
    storeFindOne.mockReturnValue(lean(tienda()));
    categoryExists.mockResolvedValue({ _id: CATEGORY });
    service = new ProductsService(
      { findOne: storeFindOne } as never,
      { exists: categoryExists } as never,
      {
        create: productCreate,
        exists: productExists,
        findOneAndUpdate: productFindOneAndUpdate,
      } as never,
      {
        create: variantCreate,
        findById: variantFindById,
        findByIdAndUpdate: variantFindByIdAndUpdate,
      } as never,
    );
  });

  describe('createProduct', () => {
    it('resuelve la tienda por ownerId y crea el producto con su storeId', async () => {
      productCreate.mockResolvedValue(producto());

      const view = await service.createProduct(OWNER, dtoProducto);

      expect(storeFindOne).toHaveBeenCalledWith({ ownerId: OWNER });
      expect(productCreate).toHaveBeenCalledWith({
        ...dtoProducto,
        storeId: STORE_ID,
      });
      expect(view.storeId).toBe(STORE_ID.toString());
    });

    it('responde 403 si el PROVEEDOR no tiene tienda', async () => {
      storeFindOne.mockReturnValue(lean(null));

      await expect(
        service.createProduct(OWNER, dtoProducto),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(productCreate).not.toHaveBeenCalled();
    });

    it('responde 403 si la tienda está desactivada', async () => {
      storeFindOne.mockReturnValue(lean(tienda({ activa: false })));

      await expect(
        service.createProduct(OWNER, dtoProducto),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(productCreate).not.toHaveBeenCalled();
    });

    it('responde 400 si la categoría no existe o está inactiva', async () => {
      categoryExists.mockResolvedValue(null);

      await expect(
        service.createProduct(OWNER, dtoProducto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(categoryExists).toHaveBeenCalledWith({
        _id: CATEGORY,
        activa: true,
      });
      expect(productCreate).not.toHaveBeenCalled();
    });
  });

  describe('updateProduct', () => {
    it('actualiza filtrando por _id y storeId propio', async () => {
      productFindOneAndUpdate.mockReturnValue(
        lean(producto({ activo: false })),
      );

      const view = await service.updateProduct(OWNER, PRODUCT_ID.toString(), {
        activo: false,
      });

      expect(productFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: PRODUCT_ID.toString(), storeId: STORE_ID },
        { $set: { activo: false } },
        { new: true },
      );
      expect(view.activo).toBe(false);
    });

    it('responde 404 si el producto es de otra tienda o no existe', async () => {
      productFindOneAndUpdate.mockReturnValue(lean(null));

      await expect(
        service.updateProduct(OWNER, PRODUCT_ID.toString(), { activo: false }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('responde 403 sin tienda', async () => {
      storeFindOne.mockReturnValue(lean(null));

      await expect(
        service.updateProduct(OWNER, PRODUCT_ID.toString(), { activo: false }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('responde 400 si el nuevo categoryId está inactivo', async () => {
      categoryExists.mockResolvedValue(null);

      await expect(
        service.updateProduct(OWNER, PRODUCT_ID.toString(), {
          categoryId: CATEGORY,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(productFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it('no consulta categorías si no cambia categoryId', async () => {
      productFindOneAndUpdate.mockReturnValue(lean(producto()));

      await service.updateProduct(OWNER, PRODUCT_ID.toString(), {
        nombre: 'Nuevo',
      });

      expect(categoryExists).not.toHaveBeenCalled();
    });
  });

  describe('createVariant', () => {
    const dto = { presentacion: '4 L', unidad: 'L', precio: 1000, stock: 10 };

    it('crea la variante de un producto propio', async () => {
      productExists.mockResolvedValue({ _id: PRODUCT_ID });
      variantCreate.mockResolvedValue(variante({ stockReservado: 0 }));

      const view = await service.createVariant(
        OWNER,
        PRODUCT_ID.toString(),
        dto,
      );

      expect(productExists).toHaveBeenCalledWith({
        _id: PRODUCT_ID.toString(),
        storeId: STORE_ID,
      });
      expect(variantCreate).toHaveBeenCalledWith({
        ...dto,
        productId: PRODUCT_ID.toString(),
      });
      expect(view).toMatchObject({ precioVigente: 1000, disponible: 10 });
    });

    it('responde 404 si el producto es de otra tienda', async () => {
      productExists.mockResolvedValue(null);

      await expect(
        service.createVariant(OWNER, PRODUCT_ID.toString(), dto),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(variantCreate).not.toHaveBeenCalled();
    });

    it('responde 403 sin tienda', async () => {
      storeFindOne.mockReturnValue(lean(null));

      await expect(
        service.createVariant(OWNER, PRODUCT_ID.toString(), dto),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('updateVariant', () => {
    const id = oid().toString();

    beforeEach(() => {
      productExists.mockResolvedValue({ _id: PRODUCT_ID });
    });

    it('actualiza campos simples sin tocar stock', async () => {
      variantFindById.mockReturnValue(lean(variante()));
      variantFindByIdAndUpdate.mockReturnValue(
        lean(variante({ presentacion: '5 L' })),
      );

      await service.updateVariant(OWNER, id, { presentacion: '5 L' });

      expect(variantFindByIdAndUpdate).toHaveBeenCalledWith(
        id,
        { $set: { presentacion: '5 L' } },
        { new: true },
      );
    });

    it('responde 404 si la variante no existe', async () => {
      variantFindById.mockReturnValue(lean(null));

      await expect(
        service.updateVariant(OWNER, id, { activo: false }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('responde 404 si la variante es de un producto de otra tienda', async () => {
      variantFindById.mockReturnValue(lean(variante()));
      productExists.mockResolvedValue(null);

      await expect(
        service.updateVariant(OWNER, id, { activo: false }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(variantFindByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('responde 400 si la nueva oferta no es menor que el precio guardado', async () => {
      variantFindById.mockReturnValue(lean(variante({ precio: 1000 })));

      await expect(
        service.updateVariant(OWNER, id, { precioOferta: 1000 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('responde 400 si el nuevo precio deja la oferta guardada por encima', async () => {
      variantFindById.mockReturnValue(
        lean(variante({ precio: 1000, precioOferta: 800 })),
      );

      await expect(
        service.updateVariant(OWNER, id, { precio: 700 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('permite bajar el precio y quitar la oferta a la vez', async () => {
      variantFindById.mockReturnValue(
        lean(variante({ precio: 1000, precioOferta: 800 })),
      );
      variantFindByIdAndUpdate.mockReturnValue(lean(variante({ precio: 700 })));

      await service.updateVariant(OWNER, id, {
        precio: 700,
        precioOferta: null,
      });

      expect(variantFindByIdAndUpdate).toHaveBeenCalledWith(
        id,
        { $set: { precio: 700 }, $unset: { precioOferta: '' } },
        { new: true },
      );
    });

    it('precioOferta null elimina la oferta con $unset', async () => {
      variantFindById.mockReturnValue(lean(variante({ precioOferta: 800 })));
      variantFindByIdAndUpdate.mockReturnValue(lean(variante()));

      const view = await service.updateVariant(OWNER, id, {
        precioOferta: null,
      });

      expect(variantFindByIdAndUpdate).toHaveBeenCalledWith(
        id,
        { $set: {}, $unset: { precioOferta: '' } },
        { new: true },
      );
      expect(view.precioOferta).toBeUndefined();
      expect(view.precioVigente).toBe(1000);
    });

    it('fija una oferta válida con $set', async () => {
      variantFindById.mockReturnValue(lean(variante()));
      variantFindByIdAndUpdate.mockReturnValue(
        lean(variante({ precioOferta: 900 })),
      );

      const view = await service.updateVariant(OWNER, id, {
        precioOferta: 900,
      });

      expect(variantFindByIdAndUpdate).toHaveBeenCalledWith(
        id,
        { $set: { precioOferta: 900 } },
        { new: true },
      );
      expect(view.precioVigente).toBe(900);
    });
  });
});
