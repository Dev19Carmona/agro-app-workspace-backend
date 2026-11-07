import { model, Types } from 'mongoose';
import { CategorySchema } from '../schemas/category.schema.js';
import { ProcessedEventSchema } from '../schemas/processed-event.schema.js';
import { ProductVariantSchema } from '../schemas/product-variant.schema.js';
import { ProductSchema } from '../schemas/product.schema.js';
import {
  ReservationStatus,
  StockReservationSchema,
} from '../schemas/stock-reservation.schema.js';
import { StoreSchema } from '../schemas/store.schema.js';

type Indice = [Record<string, number>, Record<string, unknown>];
const indices = (schema: { indexes(): unknown[] }) =>
  schema.indexes() as Indice[];

const StoreModel = model('StoreSpec', StoreSchema);
const CategoryModel = model('CategorySpec', CategorySchema);
const ProductModel = model('ProductSpec', ProductSchema);
const VariantModel = model('VariantSpec', ProductVariantSchema);
const ReservationModel = model('ReservationSpec', StockReservationSchema);

const oid = () => new Types.ObjectId();

describe('StoreSchema', () => {
  it('tiene índice único en ownerId y compuesto activa+municipio', () => {
    expect(indices(StoreSchema)).toContainEqual([
      { ownerId: 1 },
      expect.objectContaining({ unique: true }),
    ]);
    expect(indices(StoreSchema)).toContainEqual([
      { activa: 1, municipio: 1 },
      expect.anything(),
    ]);
  });

  it('inicia activa en true', () => {
    const doc = new StoreModel({
      nombre: 'T',
      nit: '1',
      ownerId: oid(),
      municipio: 'Pasto',
    });
    expect(doc.activa).toBe(true);
    expect(doc.validateSync()).toBeUndefined();
  });
});

describe('CategorySchema', () => {
  it('tiene índice único en nombre con collation es strength 2', () => {
    expect(indices(CategorySchema)).toContainEqual([
      { nombre: 1 },
      expect.objectContaining({
        unique: true,
        collation: { locale: 'es', strength: 2 },
      }),
    ]);
  });

  it('inicia activa en true', () => {
    expect(new CategoryModel({ nombre: 'Semillas' }).activa).toBe(true);
  });
});

describe('ProductSchema', () => {
  const base = {
    storeId: oid(),
    categoryId: oid(),
    nombre: 'Herbicida',
    marca: 'Agro',
  };

  it('tiene los índices storeId+activo y categoryId+activo', () => {
    expect(indices(ProductSchema)).toContainEqual([
      { storeId: 1, activo: 1 },
      expect.anything(),
    ]);
    expect(indices(ProductSchema)).toContainEqual([
      { categoryId: 1, activo: 1 },
      expect.anything(),
    ]);
  });

  it('inicia activo true, requiresQuote false y fichaTecnica vacía', () => {
    const doc = new ProductModel(base);
    expect(doc.activo).toBe(true);
    expect(doc.requiresQuote).toBe(false);
    expect(doc.fichaTecnica).toEqual({});
    expect(doc.validateSync()).toBeUndefined();
  });

  it('rechaza una fichaTecnica con más de 30 entradas', () => {
    const ficha = Object.fromEntries(
      Array.from({ length: 31 }, (_, i) => [`k${i}`, 'v']),
    );
    const error = new ProductModel({
      ...base,
      fichaTecnica: ficha,
    }).validateSync();
    expect(error?.errors.fichaTecnica).toBeDefined();
  });

  it('rechaza clave > 50 y valor > 500', () => {
    const larga = new ProductModel({
      ...base,
      fichaTecnica: { ['k'.repeat(51)]: 'v' },
    }).validateSync();
    const valor = new ProductModel({
      ...base,
      fichaTecnica: { k: 'v'.repeat(501) },
    }).validateSync();
    expect(larga?.errors.fichaTecnica).toBeDefined();
    expect(valor?.errors.fichaTecnica).toBeDefined();
  });
});

describe('ProductVariantSchema', () => {
  const base = {
    productId: oid(),
    presentacion: '4 L',
    unidad: 'L',
    precio: 1000,
    stock: 10,
  };

  it('tiene índice productId+activo y parcial en precioOferta', () => {
    expect(indices(ProductVariantSchema)).toContainEqual([
      { productId: 1, activo: 1 },
      expect.anything(),
    ]);
    expect(indices(ProductVariantSchema)).toContainEqual([
      { precioOferta: 1 },
      expect.objectContaining({
        partialFilterExpression: { precioOferta: { $exists: true } },
      }),
    ]);
  });

  it('inicia stockReservado en 0 y activo en true', () => {
    const doc = new VariantModel(base);
    expect(doc.stockReservado).toBe(0);
    expect(doc.activo).toBe(true);
    expect(doc.validateSync()).toBeUndefined();
  });

  it('rechaza precioOferta >= precio', () => {
    const igual = new VariantModel({
      ...base,
      precioOferta: 1000,
    }).validateSync();
    const mayor = new VariantModel({
      ...base,
      precioOferta: 1500,
    }).validateSync();
    expect(igual?.errors.precioOferta).toBeDefined();
    expect(mayor?.errors.precioOferta).toBeDefined();
  });

  it('acepta precioOferta menor que precio', () => {
    expect(
      new VariantModel({ ...base, precioOferta: 800 }).validateSync(),
    ).toBeUndefined();
  });

  it('rechaza precios y stock no enteros o fuera de rango', () => {
    const error = new VariantModel({
      ...base,
      precio: 10.5,
      stock: -1,
    }).validateSync();
    expect(error?.errors.precio).toBeDefined();
    expect(error?.errors.stock).toBeDefined();
  });

  it('rechaza una unidad de más de 20 caracteres', () => {
    const error = new VariantModel({
      ...base,
      unidad: 'u'.repeat(21),
    }).validateSync();
    expect(error?.errors.unidad).toBeDefined();
  });
});

describe('StockReservationSchema', () => {
  it('tiene índice único en orderId', () => {
    expect(indices(StockReservationSchema)).toContainEqual([
      { orderId: 1 },
      expect.objectContaining({ unique: true }),
    ]);
  });

  it('rechaza un status fuera del enum', () => {
    const error = new ReservationModel({
      orderId: 'o1',
      status: 'OTRO',
    }).validateSync();
    expect(error?.errors.status).toBeDefined();
  });

  it('acepta una reserva RESERVED con ítems', () => {
    const doc = new ReservationModel({
      orderId: 'o1',
      status: ReservationStatus.RESERVED,
      items: [{ variantId: oid(), cantidad: 2 }],
    });
    expect(doc.validateSync()).toBeUndefined();
  });
});

describe('ProcessedEventSchema', () => {
  it('tiene índice único en eventId', () => {
    expect(indices(ProcessedEventSchema)).toContainEqual([
      { eventId: 1 },
      expect.objectContaining({ unique: true }),
    ]);
  });
});
