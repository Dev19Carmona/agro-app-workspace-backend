import { z } from 'zod';
import {
  FICHA_MAX_CLAVE,
  FICHA_MAX_ENTRADAS,
  FICHA_MAX_VALOR,
} from '../schemas/product.schema.js';
import { objectIdSchema } from './catalog-query.dto.js';

const fichaTecnica = z
  .record(
    z.string().min(1).max(FICHA_MAX_CLAVE),
    z.string().max(FICHA_MAX_VALOR),
  )
  .refine(
    (f) => Object.keys(f).length <= FICHA_MAX_ENTRADAS,
    `Máximo ${FICHA_MAX_ENTRADAS} entradas`,
  );

const nombre = z.string().trim().min(1).max(200);
const marca = z.string().trim().min(1).max(100);

/** `storeId` sale de la tienda del PROVEEDOR, nunca del body. */
export const createProductSchema = z.strictObject({
  categoryId: objectIdSchema,
  nombre,
  marca,
  fichaTecnica,
  requiresQuote: z.boolean().optional(),
});
export type CreateProductDto = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
  .strictObject({
    categoryId: objectIdSchema.optional(),
    nombre: nombre.optional(),
    marca: marca.optional(),
    fichaTecnica: fichaTecnica.optional(),
    requiresQuote: z.boolean().optional(),
    activo: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Sin campos para actualizar');
export type UpdateProductDto = z.infer<typeof updateProductSchema>;
