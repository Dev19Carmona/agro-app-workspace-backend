import { z } from 'zod';

/** Id de ruta, query o body: un ObjectId de Mongo (24 hex). Nada más llega a la consulta. */
export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'id inválido');

/** `:variantId` de `PUT` y `DELETE /orders/cart/items/:variantId`. */
export const variantIdParamSchema = objectIdSchema;

export const MAX_CART_QUANTITY = 1000;
export const MAX_CART_LINES = 50;

/** `PUT /orders/cart/items/:variantId`. Valor absoluto, no un delta. */
export const setCartItemSchema = z.strictObject({
  cantidad: z.number().int().min(1).max(MAX_CART_QUANTITY),
});
export type SetCartItemDto = z.infer<typeof setCartItemSchema>;
