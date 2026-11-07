import { z } from 'zod';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

/** Id de ruta, query o body: un ObjectId de Mongo (24 hex). Nada más llega a la consulta. */
export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'id inválido');

const paginacion = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
};

const municipio = z.string().trim().min(1).max(100);

/** `GET /catalog/products` y `GET /catalog/offers`. */
export const productsQuerySchema = z.strictObject({
  ...paginacion,
  categoryId: objectIdSchema.optional(),
  storeId: objectIdSchema.optional(),
  municipio: municipio.optional(),
});
export type ProductsQuery = z.infer<typeof productsQuerySchema>;

/** `GET /catalog/stores` y `GET /catalog/admin/stores`. */
export const storesQuerySchema = z.strictObject({
  ...paginacion,
  municipio: municipio.optional(),
});
export type StoresQuery = z.infer<typeof storesQuerySchema>;
