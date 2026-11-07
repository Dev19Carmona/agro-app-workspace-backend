import { z } from 'zod';
import { Role } from '../../../../../../libs/common/src/security/roles.js';
import { UserStatus } from '../schemas/user.schema.js';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

/** `:id` de la ruta: un ObjectId de Mongo (24 hex). Nada más llega a la consulta. */
export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'id inválido');

/** Filtros y paginación de `GET /auth/users`. El tamaño de página tiene tope. */
export const listUsersQuerySchema = z.strictObject({
  rol: z.enum(Role).optional(),
  status: z.enum(UserStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/** El body de `reject` es opcional: el motivo también. */
export const rejectSchema = z
  .strictObject({ reason: z.string().trim().min(1).max(500).optional() })
  .optional();
export type RejectDto = z.infer<typeof rejectSchema>;

export const changeRoleSchema = z.strictObject({ rol: z.enum(Role) });
export type ChangeRoleDto = z.infer<typeof changeRoleSchema>;
