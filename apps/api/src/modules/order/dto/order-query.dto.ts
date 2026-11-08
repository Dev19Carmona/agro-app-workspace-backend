import { z } from 'zod';
import { objectIdSchema } from './cart.dto.js';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

const paginacion = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
};

const statusSchema = z.enum([
  'PENDING',
  'AWAITING_PAYMENT',
  'CONFIRMED',
  'CANCELLED',
]);

/** `GET /orders` (PRODUCTOR). */
export const ordersQuerySchema = z.strictObject({
  ...paginacion,
  status: statusSchema.optional(),
});
export type OrdersQuery = z.infer<typeof ordersQuerySchema>;

/** `GET /orders/provider/sub-orders` (PROVEEDOR): solo paginación. */
export const providerSubOrdersQuerySchema = z.strictObject(paginacion);
export type ProviderSubOrdersQuery = z.infer<
  typeof providerSubOrdersQuerySchema
>;

/** `GET /orders/admin` (ADMIN). */
export const adminOrdersQuerySchema = z.strictObject({
  ...paginacion,
  status: statusSchema.optional(),
  buyerId: objectIdSchema.optional(),
});
export type AdminOrdersQuery = z.infer<typeof adminOrdersQuerySchema>;
