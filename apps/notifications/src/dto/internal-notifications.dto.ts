import { z } from 'zod';

/** Id de usuario, tienda, aviso o cursor: un ObjectId de Mongo (24 hex). */
export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'id inválido');

export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 20;

/** Actor que `api` arma desde el JWT: el usuario y, para el PROVEEDOR, su tienda. */
const actor = {
  userId: objectIdSchema,
  storeId: objectIdSchema.optional(),
};

/** `GET /internal/notifications`. */
export const listQuerySchema = z.strictObject({
  ...actor,
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  cursor: objectIdSchema.optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

/** `GET /internal/notifications/unread-count`. */
export const actorQuerySchema = z.strictObject(actor);
export type ActorQuery = z.infer<typeof actorQuerySchema>;

/** Cuerpo de `PATCH :id/read` y `POST read-all`. */
export const actorBodySchema = z.strictObject(actor);
export type ActorBody = z.infer<typeof actorBodySchema>;
