import {
  productsQuerySchema,
  storesQuerySchema,
} from '../dto/catalog-query.dto.js';
import {
  createCategorySchema,
  updateCategorySchema,
} from '../dto/category.dto.js';
import {
  createProductSchema,
  updateProductSchema,
} from '../dto/product.dto.js';
import { createStoreSchema, updateStoreSchema } from '../dto/store.dto.js';
import {
  createVariantSchema,
  setStockSchema,
  updateVariantSchema,
} from '../dto/variant.dto.js';

const id = 'a'.repeat(24);
const tienda = { nombre: 'Agro Sur', nit: '900123', municipio: 'Pasto' };
const producto = {
  categoryId: id,
  nombre: 'Herbicida',
  marca: 'Agro',
  fichaTecnica: { ingrediente: 'glifosato' },
};
const variante = { presentacion: '4 L', unidad: 'L', precio: 1000, stock: 5 };
const ok = (r: { success: boolean }) => r.success;

describe('catalog-query DTO', () => {
  it('aplica page 1 y limit 20 por defecto', () => {
    const r = productsQuerySchema.parse({});
    expect(r.page).toBe(1);
    expect(r.limit).toBe(20);
  });

  it('rechaza limit 101 y acepta 100', () => {
    expect(ok(productsQuerySchema.safeParse({ limit: '101' }))).toBe(false);
    expect(ok(storesQuerySchema.safeParse({ limit: '101' }))).toBe(false);
    expect(ok(productsQuerySchema.safeParse({ limit: '100' }))).toBe(true);
  });

  it('rechaza page 0', () => {
    expect(ok(productsQuerySchema.safeParse({ page: '0' }))).toBe(false);
  });

  it('rechaza propiedades desconocidas', () => {
    expect(ok(productsQuerySchema.safeParse({ q: 'x' }))).toBe(false);
  });

  it.each(['categoryId', 'storeId', 'municipio'])(
    'rechaza un operador {"$ne": null} en %s',
    (campo) => {
      expect(
        ok(productsQuerySchema.safeParse({ [campo]: { $ne: null } })),
      ).toBe(false);
    },
  );

  it('rechaza un id que no es ObjectId', () => {
    expect(ok(productsQuerySchema.safeParse({ storeId: 'abc' }))).toBe(false);
  });
});

describe('store DTO', () => {
  it('acepta una tienda válida', () => {
    expect(ok(createStoreSchema.safeParse(tienda))).toBe(true);
  });

  it.each(['ownerId', 'activa', 'storeId'])(
    'rechaza %s en el body',
    (campo) => {
      expect(ok(createStoreSchema.safeParse({ ...tienda, [campo]: id }))).toBe(
        false,
      );
    },
  );

  it('rechaza un operador {"$ne": null} en un campo', () => {
    expect(
      ok(createStoreSchema.safeParse({ ...tienda, nombre: { $ne: null } })),
    ).toBe(false);
  });

  it('el PATCH admin exige algún campo y no admite activa', () => {
    expect(ok(updateStoreSchema.safeParse({}))).toBe(false);
    expect(ok(updateStoreSchema.safeParse({ activa: false }))).toBe(false);
    expect(ok(updateStoreSchema.safeParse({ nit: '1' }))).toBe(true);
  });
});

describe('category DTO', () => {
  it('acepta nombre y rechaza extras', () => {
    expect(ok(createCategorySchema.safeParse({ nombre: 'Semillas' }))).toBe(
      true,
    );
    expect(
      ok(createCategorySchema.safeParse({ nombre: 'S', activa: true })),
    ).toBe(false);
  });

  it('el PATCH acepta activa y exige algún campo', () => {
    expect(ok(updateCategorySchema.safeParse({ activa: false }))).toBe(true);
    expect(ok(updateCategorySchema.safeParse({}))).toBe(false);
  });
});

describe('product DTO', () => {
  it('acepta un producto válido', () => {
    expect(ok(createProductSchema.safeParse(producto))).toBe(true);
  });

  it.each(['storeId', 'activo'])(
    'rechaza %s en el body de creación',
    (campo) => {
      expect(
        ok(createProductSchema.safeParse({ ...producto, [campo]: id })),
      ).toBe(false);
    },
  );

  it('rechaza un operador {"$ne": null} en categoryId', () => {
    expect(
      ok(
        createProductSchema.safeParse({
          ...producto,
          categoryId: { $ne: null },
        }),
      ),
    ).toBe(false);
  });

  it('acota fichaTecnica: 30 entradas, clave 50, valor 500', () => {
    const treinta = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`k${i}`, 'v']),
    );
    const con = (fichaTecnica: Record<string, string>) =>
      ok(createProductSchema.safeParse({ ...producto, fichaTecnica }));
    expect(con(treinta)).toBe(true);
    expect(con({ ...treinta, extra: 'v' })).toBe(false);
    expect(con({ ['k'.repeat(51)]: 'v' })).toBe(false);
    expect(con({ k: 'v'.repeat(501) })).toBe(false);
  });

  it('el PATCH acepta activo, rechaza storeId y exige algún campo', () => {
    expect(ok(updateProductSchema.safeParse({ activo: false }))).toBe(true);
    expect(ok(updateProductSchema.safeParse({ storeId: id }))).toBe(false);
    expect(ok(updateProductSchema.safeParse({}))).toBe(false);
  });
});

describe('variant DTO', () => {
  it('acepta una variante válida', () => {
    expect(ok(createVariantSchema.safeParse(variante))).toBe(true);
  });

  it('rechaza precioOferta mayor o igual a precio', () => {
    const con = (precioOferta: number) =>
      ok(createVariantSchema.safeParse({ ...variante, precioOferta }));
    expect(con(1000)).toBe(false);
    expect(con(1500)).toBe(false);
    expect(con(900)).toBe(true);
  });

  it('rechaza precios decimales, cero o negativos y stock negativo', () => {
    const con = (cambio: Record<string, number>) =>
      ok(createVariantSchema.safeParse({ ...variante, ...cambio }));
    expect(con({ precio: 10.5 })).toBe(false);
    expect(con({ precio: 0 })).toBe(false);
    expect(con({ stock: -1 })).toBe(false);
  });

  it('rechaza stockReservado y unidad de más de 20 caracteres', () => {
    expect(
      ok(createVariantSchema.safeParse({ ...variante, stockReservado: 0 })),
    ).toBe(false);
    expect(
      ok(
        createVariantSchema.safeParse({ ...variante, unidad: 'u'.repeat(21) }),
      ),
    ).toBe(false);
  });

  it('el PATCH admite precioOferta null y no toca stock', () => {
    expect(ok(updateVariantSchema.safeParse({ precioOferta: null }))).toBe(
      true,
    );
    expect(ok(updateVariantSchema.safeParse({ stock: 1 }))).toBe(false);
    expect(
      ok(updateVariantSchema.safeParse({ precio: 500, precioOferta: 500 })),
    ).toBe(false);
    expect(ok(updateVariantSchema.safeParse({}))).toBe(false);
  });

  it('setStock es un valor absoluto entero ≥ 0', () => {
    expect(ok(setStockSchema.safeParse({ stock: 0 }))).toBe(true);
    expect(ok(setStockSchema.safeParse({ stock: -1 }))).toBe(false);
    expect(ok(setStockSchema.safeParse({ stock: 1.5 }))).toBe(false);
    expect(ok(setStockSchema.safeParse({ stock: { $ne: null } }))).toBe(false);
  });
});
