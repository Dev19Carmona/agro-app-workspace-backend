import { z } from 'zod';

const nombre = z.string().trim().min(1).max(120);
const nit = z.string().trim().min(1).max(30);
const municipio = z.string().trim().min(1).max(100);

/** `ownerId` sale del token, nunca del body (strictObject lo rechaza). */
export const createStoreSchema = z.strictObject({ nombre, nit, municipio });
export type CreateStoreDto = z.infer<typeof createStoreSchema>;

/** `PATCH /catalog/admin/stores/:id`: solo estos tres campos. */
export const updateStoreSchema = z
  .strictObject({
    nombre: nombre.optional(),
    nit: nit.optional(),
    municipio: municipio.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Sin campos para actualizar');
export type UpdateStoreDto = z.infer<typeof updateStoreSchema>;
