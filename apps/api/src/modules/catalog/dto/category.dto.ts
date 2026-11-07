import { z } from 'zod';

const nombre = z.string().trim().min(1).max(100);

export const createCategorySchema = z.strictObject({ nombre });
export type CreateCategoryDto = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .strictObject({ nombre: nombre.optional(), activa: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Sin campos para actualizar');
export type UpdateCategoryDto = z.infer<typeof updateCategorySchema>;
