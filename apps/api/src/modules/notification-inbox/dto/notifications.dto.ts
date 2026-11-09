import { z } from 'zod';

/** `:id` o `cursor`: un ObjectId de Mongo (24 hex). Nada más llega a la consulta. */
export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'id inválido');

export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 20;

/**
 * `GET /notifications`. Estricto: no acepta `userId` ni `storeId`, el actor sale del token.
 * La paginación es por cursor (el `id` del último aviso de la página anterior).
 */
export const notificationsQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  cursor: objectIdSchema.optional(),
});
export type NotificationsQuery = z.infer<typeof notificationsQuerySchema>;
