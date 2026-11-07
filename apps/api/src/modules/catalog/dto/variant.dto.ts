import { z } from 'zod';

const presentacion = z.string().trim().min(1).max(100);
const unidad = z.string().trim().min(1).max(20);
/** Enteros en COP, sin decimales. */
const precio = z.number().int().positive();
const stock = z.number().int().min(0);

const ofertaMenorQuePrecio = (v: {
  precio?: number;
  precioOferta?: number | null;
}) =>
  v.precio === undefined ||
  v.precioOferta === undefined ||
  v.precioOferta === null ||
  v.precioOferta < v.precio;
const mensajeOferta = {
  message: 'precioOferta debe ser menor que precio',
  path: ['precioOferta'],
};

export const createVariantSchema = z
  .strictObject({
    presentacion,
    unidad,
    precio,
    precioOferta: precio.optional(),
    stock,
  })
  .refine(ofertaMenorQuePrecio, mensajeOferta);
export type CreateVariantDto = z.infer<typeof createVariantSchema>;

/** No toca `stock` ni `stockReservado`. `precioOferta: null` quita la oferta. */
export const updateVariantSchema = z
  .strictObject({
    presentacion: presentacion.optional(),
    unidad: unidad.optional(),
    precio: precio.optional(),
    precioOferta: precio.nullable().optional(),
    activo: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Sin campos para actualizar')
  .refine(ofertaMenorQuePrecio, mensajeOferta);
export type UpdateVariantDto = z.infer<typeof updateVariantSchema>;

/** Valor absoluto, no un delta. */
export const setStockSchema = z.strictObject({ stock });
export type SetStockDto = z.infer<typeof setStockSchema>;
