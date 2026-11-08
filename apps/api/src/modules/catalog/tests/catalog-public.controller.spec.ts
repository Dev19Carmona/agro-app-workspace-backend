import {
  type INestApplication,
  StandardSchemaValidationPipe,
} from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { IS_PUBLIC_KEY } from '../../../../../../libs/common/src/security/decorators.js';
import { CatalogPublicController } from '../controllers/catalog-public.controller.js';
import { CatalogQueryService } from '../services/catalog-query.service.js';

const ID = '6aee7a351616d80ba08c95b4';

describe('CatalogPublicController', () => {
  const catalog = {
    listProducts: vi.fn(),
    getProduct: vi.fn(),
    listOffers: vi.fn(),
    listStores: vi.fn(),
    getStore: vi.fn(),
    listCategories: vi.fn(),
  };
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [CatalogPublicController],
      providers: [
        { provide: CatalogQueryService, useValue: catalog },
        { provide: APP_PIPE, useClass: StandardSchemaValidationPipe },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each([
    'listProducts',
    'getProduct',
    'listOffers',
    'listStores',
    'getStore',
    'listCategories',
  ] as const)('%s está marcado @Public()', (metodo) => {
    const handler = Object.getOwnPropertyDescriptor(
      CatalogPublicController.prototype,
      metodo,
    )?.value;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
  });

  it('GET /catalog/products usa page 1 y limit 20 por defecto', async () => {
    catalog.listProducts.mockResolvedValue({ data: [] });

    const res = await http().get('/catalog/products');

    expect(res.status).toBe(200);
    expect(catalog.listProducts).toHaveBeenCalledWith({ page: 1, limit: 20 });
  });

  it('GET /catalog/products pasa los filtros validados', async () => {
    catalog.listProducts.mockResolvedValue({ data: [] });

    await http().get(
      `/catalog/products?categoryId=${ID}&storeId=${ID}&municipio=Pasto&limit=100`,
    );

    expect(catalog.listProducts).toHaveBeenCalledWith({
      page: 1,
      limit: 100,
      categoryId: ID,
      storeId: ID,
      municipio: 'Pasto',
    });
  });

  it.each(['/catalog/products', '/catalog/offers', '/catalog/stores'])(
    'GET %s rechaza limit=101 con 400',
    async (ruta) => {
      const res = await http().get(`${ruta}?limit=101`);

      expect(res.status).toBe(400);
      expect(catalog.listProducts).not.toHaveBeenCalled();
      expect(catalog.listOffers).not.toHaveBeenCalled();
      expect(catalog.listStores).not.toHaveBeenCalled();
    },
  );

  it('rechaza un operador {"$ne": null} en la query con 400', async () => {
    const res = await http().get('/catalog/products?categoryId[$ne]=');

    expect(res.status).toBe(400);
    expect(catalog.listProducts).not.toHaveBeenCalled();
  });

  it('GET /catalog/products/:id valida el id', async () => {
    catalog.getProduct.mockResolvedValue({ id: ID });

    const ok = await http().get(`/catalog/products/${ID}`);
    const mal = await http().get('/catalog/products/abc');

    expect(ok.status).toBe(200);
    expect(catalog.getProduct).toHaveBeenCalledWith(ID);
    expect(mal.status).toBe(400);
  });

  it('GET /catalog/offers, /stores, /stores/:id y /categories responden 200', async () => {
    catalog.listOffers.mockResolvedValue({ data: [] });
    catalog.listStores.mockResolvedValue({ data: [] });
    catalog.getStore.mockResolvedValue({ id: ID });
    catalog.listCategories.mockResolvedValue([]);

    expect((await http().get('/catalog/offers')).status).toBe(200);
    expect((await http().get('/catalog/stores')).status).toBe(200);
    expect((await http().get(`/catalog/stores/${ID}`)).status).toBe(200);
    expect((await http().get('/catalog/categories')).status).toBe(200);
  });
});
