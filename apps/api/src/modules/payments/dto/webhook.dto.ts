import { z } from 'zod';
import { objectIdSchema } from './create-payment.dto.js';

/**
 * Cuerpo de `POST /payments/webhook`. Se parsea con `safeParse` después de
 * verificar la firma, no con `@Body({ schema })`.
 */
export const webhookSchema = z.strictObject({
  eventId: z.uuid(),
  paymentId: objectIdSchema,
  resultado: z.enum(['APPROVED', 'DECLINED', 'ERROR']),
  motivo: z.string().max(200).optional(),
});
export type WebhookDto = z.infer<typeof webhookSchema>;
