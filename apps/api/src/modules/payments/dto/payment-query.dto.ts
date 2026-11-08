import { z } from 'zod';
import { objectIdSchema } from './create-payment.dto.js';

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
  'PROCESSING',
  'APPROVED',
  'DECLINED',
  'ERROR',
]);

/** `GET /payments` (PRODUCTOR). */
export const paymentsQuerySchema = z.strictObject({
  ...paginacion,
  status: statusSchema.optional(),
  orderId: objectIdSchema.optional(),
});
export type PaymentsQuery = z.infer<typeof paymentsQuerySchema>;

/** `GET /payments/admin` (ADMIN). */
export const adminPaymentsQuerySchema = z.strictObject({
  ...paginacion,
  status: statusSchema.optional(),
  buyerId: objectIdSchema.optional(),
  orderId: objectIdSchema.optional(),
});
export type AdminPaymentsQuery = z.infer<typeof adminPaymentsQuerySchema>;
