import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { CatalogQueryService } from '../services/catalog-query.service.js';

const oid = () => new Types.ObjectId();
const STORE_ID = oid();
const PRODUCT_ID = oid();

const lean = (valor: unknown) => ({ lean: async () => valor });
/** Cadena de consulta paginada que termina en `.lean()`. */
const paginada = (resultado: unknown[]) => {
  const chain = {
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: async () => resultado,
  };
  return chain;
};

const producto = (extra: Record<string, unknown> = {}) => ({
  _id: PRODUCT_ID,
  storeId: STORE_ID,
  categoryId: oid(),
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
  stockReservado: 4,
  activo: true,
  ...extra,
});

describe('CatalogQueryService (consulta pública)', () => {
  const storeDistinct = vi.fn();
  const storeFind = vi.fn();
  const storeFindOne = vi.fn();
  const storeExists = vi.fn();
  const storeCount = vi.fn();
  const categoryFind = vi.fn();
  const productFind = vi.fn();
  const productFindOne = vi.fn();
  const productDistinct = vi.fn();
  const productCount = vi.fn();
  const variantFind = vi.fn();
  const variantCount = vi.fn();
  let service: CatalogQueryService;

  beforeEach(() => {
    vi.resetAllMocks();
    storeDistinct.mockResolvedValue([STORE_ID]);
    service = new CatalogQueryService(
      {
        distinct: storeDistinct,
        find: storeFind,
        findOne: storeFindOne,
        exists: storeExists,
        countDocuments: storeCount,
      } as never,
      { find: categoryFind } as never,
      {
        find: productFind,
        findOne: productFindOne,
        distinct: productDistinct,
        countDocuments: productCount,
      } as never,
      { find: variantFind, countDocuments: variantCount } as never,
    );
  });

  describe('listProducts', () => {
    it('solo busca productos activos de tiendas activas', async () => {
      const chain = paginada([producto()]);
      productFind.mockReturnValue(chain);
      productCount.mockResolvedValue(1);

      const page = await service.listProducts({ page: 1, limit: 20 });

      expect(storeDistinct).toHaveBeenCalledWith('_id', { activa: true });
      expect(productFind).toHaveBeenCalledWith({
        activo: true,
        storeId: { $in: [STORE_ID] },
      });
      expect(page.data[0]).toMatchObject({ requiresQuote: false });
      expect(page.total).toBe(1);
    });

    it('aplica categoryId, storeId y municipio, y pagina', async () => {
      const categoryId = oid().toString();
      const chain = paginada([]);
      productFind.mockReturnValue(chain);
      productCount.mockResolvedValue(0);

      await service.listProducts({
        page: 3,
        limit: 10,
        categoryId,
        storeId: STORE_ID.toString(),
        municipio: 'Pasto',
      });

      expect(storeDistinct).toHaveBeenCalledWith('_id', {
        activa: true,
        _id: STORE_ID.toString(),
        municipio: 'Pasto',
      });
      expect(productFind).toHaveBeenCalledWith({
        activo: true,
        storeId: { $in: [STORE_ID] },
        categoryId,
      });
      expect(chain.skip).toHaveBeenCalledWith(20);
      expect(chain.limit).toHaveBeenCalledWith(10);
    });

    it('una tienda desactivada deja la lista vacía ($in vacío)', async () => {
      storeDistinct.mockResolvedValue([]);
      productFind.mockReturnValue(paginada([]));
      productCount.mockResolvedValue(0);

      await service.listProducts({ page: 1, limit: 20 });

      expect(productFind).toHaveBeenCalledWith({
        activo: true,
        storeId: { $in: [] },
      });
    });
  });

  describe('getProduct', () => {
    it('devuelve precioVigente y disponible = stock - stockReservado', async () => {
      productFindOne.mockReturnValue(lean(producto()));
      storeExists.mockResolvedValue({ _id: STORE_ID });
      const chain = {
        sort: vi.fn().mockReturnThis(),
        lean: async () => [
          variante({ precioOferta: 800 }),
          variante({ stock: 5, stockReservado: 5 }),
        ],
      };
      variantFind.mockReturnValue(chain);

      const detail = await service.getProduct(PRODUCT_ID.toString());

      expect(productFindOne).toHaveBeenCalledWith({
        _id: PRODUCT_ID.toString(),
        activo: true,
      });
      expect(storeExists).toHaveBeenCalledWith({
        _id: STORE_ID,
        activa: true,
      });
      expect(variantFind).toHaveBeenCalledWith({
        productId: PRODUCT_ID,
        activo: true,
      });
      expect(detail.variantes[0]).toMatchObject({
        precio: 1000,
        precioOferta: 800,
        precioVigente: 800,
        disponible: 6,
      });
      expect(detail.variantes[1]).toMatchObject({
        precioVigente: 1000,
        disponible: 0,
      });
      expect(detail.variantes[0]).not.toHaveProperty('stock');
      expect(detail.variantes[0]).not.toHaveProperty('stockReservado');
    });

    it('responde 404 si el producto está inactivo o no existe', async () => {
      productFindOne.mockReturnValue(lean(null));

      await expect(service.getProduct('x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(storeExists).not.toHaveBeenCalled();
    });

    it('responde 404 si la tienda está desactivada', async () => {
      productFindOne.mockReturnValue(lean(producto()));
      storeExists.mockResolvedValue(null);

      await expect(service.getProduct('x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(variantFind).not.toHaveBeenCalled();
    });
  });

  describe('listOffers', () => {
    it('solo variantes activas con precioOferta de productos sin cotización', async () => {
      productDistinct.mockResolvedValue([PRODUCT_ID]);
      variantFind.mockReturnValue(paginada([variante({ precioOferta: 700 })]));
      variantCount.mockResolvedValue(1);

      const page = await service.listOffers({ page: 1, limit: 20 });

      expect(productDistinct).toHaveBeenCalledWith('_id', {
        activo: true,
        storeId: { $in: [STORE_ID] },
        requiresQuote: false,
      });
      expect(variantFind).toHaveBeenCalledWith({
        activo: true,
        precioOferta: { $exists: true },
        productId: { $in: [PRODUCT_ID] },
      });
      expect(page.data[0].precioVigente).toBe(700);
    });
  });

  describe('getCheckoutVariants', () => {
    const variantId = oid();
    const tienda = (extra: Record<string, unknown> = {}) => ({
      _id: STORE_ID,
      activa: true,
      ...extra,
    });

    /** Prepara variante, producto y tienda como los devolvería Mongo. */
    const preparar = (
      v: Record<string, unknown> = {},
      p: Record<string, unknown> = {},
      s: Record<string, unknown> = {},
    ) => {
      variantFind.mockReturnValue(lean([variante({ _id: variantId, ...v })]));
      productFind.mockReturnValue(lean([producto(p)]));
      storeFind.mockReturnValue(lean([tienda(s)]));
    };

    it('devuelve la variante con el precio de oferta y apta', async () => {
      preparar({ precioOferta: 800 });

      const [item] = await service.getCheckoutVariants([variantId.toString()]);

      expect(item).toEqual({
        variantId: variantId.toString(),
        productId: PRODUCT_ID.toString(),
        storeId: STORE_ID.toString(),
        nombreProducto: 'Herbicida',
        presentacion: '4 L',
        unidad: 'L',
        precioVigente: 800,
        disponible: 6,
        apta: true,
      });
    });

    it('usa el precio base cuando no hay oferta', async () => {
      preparar();

      const [item] = await service.getCheckoutVariants([variantId.toString()]);

      expect(item.precioVigente).toBe(1000);
    });

    it('apta = false si el producto requiere cotización', async () => {
      preparar({}, { requiresQuote: true });

      const [item] = await service.getCheckoutVariants([variantId.toString()]);

      expect(item.apta).toBe(false);
    });

    it.each([
      ['variante inactiva', { activo: false }, {}, {}],
      ['producto inactivo', {}, { activo: false }, {}],
      ['tienda desactivada', {}, {}, { activa: false }],
    ])('apta = false con %s', async (_caso, v, p, s) => {
      preparar(v, p, s);

      const [item] = await service.getCheckoutVariants([variantId.toString()]);

      expect(item.apta).toBe(false);
    });

    it('una variante inexistente no aparece en el resultado', async () => {
      variantFind.mockReturnValue(lean([]));
      productFind.mockReturnValue(lean([]));
      storeFind.mockReturnValue(lean([]));

      const result = await service.getCheckoutVariants([oid().toString()]);

      expect(result).toEqual([]);
    });

    it('ignora ids inválidos sin consultar Mongo y no repite ids', async () => {
      expect(
        await service.getCheckoutVariants(['abc', '{"$ne":null}']),
      ).toEqual([]);
      expect(variantFind).not.toHaveBeenCalled();

      preparar();
      const id = variantId.toString();
      const result = await service.getCheckoutVariants([id, id]);

      expect(variantFind).toHaveBeenCalledWith({ _id: { $in: [id] } });
      expect(result).toHaveLength(1);
    });
  });

  describe('tiendas y categorías', () => {
    it('listStores solo trae tiendas activas y no expone ownerId ni nit', async () => {
      storeFind.mockReturnValue(
        paginada([
          {
            _id: STORE_ID,
            nombre: 'Agro Sur',
            nit: '900',
            ownerId: oid(),
            municipio: 'Pasto',
            activa: true,
          },
        ]),
      );
      storeCount.mockResolvedValue(1);

      const page = await service.listStores({
        page: 1,
        limit: 20,
        municipio: 'Pasto',
      });

      expect(storeFind).toHaveBeenCalledWith({
        activa: true,
        municipio: 'Pasto',
      });
      expect(page.data[0]).toEqual({
        id: STORE_ID.toString(),
        nombre: 'Agro Sur',
        municipio: 'Pasto',
      });
    });

    it('getStore responde 404 si la tienda está desactivada', async () => {
      storeFindOne.mockReturnValue(lean(null));

      await expect(service.getStore('x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(storeFindOne).toHaveBeenCalledWith({ _id: 'x', activa: true });
    });

    it('listCategories solo trae categorías activas', async () => {
      const id = oid();
      categoryFind.mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        lean: async () => [{ _id: id, nombre: 'Semillas', activa: true }],
      });

      const lista = await service.listCategories();

      expect(categoryFind).toHaveBeenCalledWith({ activa: true });
      expect(lista).toEqual([{ id: id.toString(), nombre: 'Semillas' }]);
    });
  });
});
