import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { StockService } from '../services/stock.service.js';

const oid = () => new Types.ObjectId();
const OWNER = oid().toString();
const STORE_ID = oid();
const PRODUCT_ID = oid();
const VARIANT_ID = oid().toString();

const variante = (extra: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(VARIANT_ID),
  productId: PRODUCT_ID,
  presentacion: '4 L',
  unidad: 'L',
  precio: 1000,
  stock: 10,
  stockReservado: 4,
  activo: true,
  ...extra,
});
const lean = (valor: unknown) => ({ lean: async () => valor });

describe('StockService.setStock', () => {
  const storeFindOne = vi.fn();
  const productExists = vi.fn();
  const variantFindById = vi.fn();
  const variantFindOneAndUpdate = vi.fn();
  let service: StockService;

  beforeEach(() => {
    vi.resetAllMocks();
    storeFindOne.mockReturnValue(lean({ _id: STORE_ID }));
    variantFindById.mockReturnValue(lean(variante()));
    productExists.mockResolvedValue({ _id: PRODUCT_ID });
    service = new StockService(
      { findOne: storeFindOne } as never,
      { exists: productExists } as never,
      {
        findById: variantFindById,
        findOneAndUpdate: variantFindOneAndUpdate,
      } as never,
    );
  });

  it('fija el stock con una actualización condicional stockReservado <= stock', async () => {
    variantFindOneAndUpdate.mockReturnValue(lean(variante({ stock: 20 })));

    const view = await service.setStock(OWNER, VARIANT_ID, 20);

    expect(productExists).toHaveBeenCalledWith({
      _id: PRODUCT_ID,
      storeId: STORE_ID,
    });
    expect(variantFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: VARIANT_ID, $expr: { $lte: ['$stockReservado', 20] } },
      { $set: { stock: 20 } },
      { new: true },
    );
    expect(view).toMatchObject({ stock: 20, disponible: 16 });
  });

  it('acepta un stock igual al reservado', async () => {
    variantFindOneAndUpdate.mockReturnValue(lean(variante({ stock: 4 })));

    const view = await service.setStock(OWNER, VARIANT_ID, 4);

    expect(view.disponible).toBe(0);
  });

  it('responde 409 si stock < stockReservado (la condición no encuentra la variante)', async () => {
    variantFindOneAndUpdate.mockReturnValue(lean(null));

    await expect(service.setStock(OWNER, VARIANT_ID, 3)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(variantFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: VARIANT_ID, $expr: { $lte: ['$stockReservado', 3] } },
      { $set: { stock: 3 } },
      { new: true },
    );
  });

  it('responde 404 si la variante pertenece a un producto de otra tienda', async () => {
    productExists.mockResolvedValue(null);

    await expect(service.setStock(OWNER, VARIANT_ID, 5)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(variantFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('responde 404 si la variante no existe', async () => {
    variantFindById.mockReturnValue(lean(null));

    await expect(service.setStock(OWNER, VARIANT_ID, 5)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(productExists).not.toHaveBeenCalled();
    expect(variantFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('responde 403 si el PROVEEDOR no tiene tienda', async () => {
    storeFindOne.mockReturnValue(lean(null));

    await expect(service.setStock(OWNER, VARIANT_ID, 5)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(variantFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
