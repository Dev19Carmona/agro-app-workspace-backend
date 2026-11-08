import { z } from 'zod';

/** Header `Idempotency-Key` de `POST /orders/checkout`: de 8 a 100 caracteres. */
export const idempotencyKeySchema = z.string().trim().min(8).max(100);
