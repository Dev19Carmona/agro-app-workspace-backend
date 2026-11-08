import { z } from 'zod';

/** Id de ruta, query o body: un ObjectId de Mongo (24 hex). Nada más llega a la consulta. */
export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'id inválido');

/** `:id` de `GET /payments/:id` y `GET /payments/admin/:id`. */
export const paymentIdParamSchema = objectIdSchema;

/** Header `Idempotency-Key` de `POST /payments`: de 8 a 100 caracteres. */
export const idempotencyKeySchema = z.string().trim().min(8).max(100);

export const paymentMetodoSchema = z.enum(['CARD', 'PSE', 'NEQUI']);

/**
 * `POST /payments`. El cliente nunca envía monto ni datos de tarjeta; cualquier
 * token se acepta aquí y uno desconocido lo rechaza el simulador como `DECLINED`.
 */
export const createPaymentSchema = z.strictObject({
  orderId: objectIdSchema,
  metodo: paymentMetodoSchema,
  token: z.string().min(1).max(100),
});
export type CreatePaymentDto = z.infer<typeof createPaymentSchema>;
