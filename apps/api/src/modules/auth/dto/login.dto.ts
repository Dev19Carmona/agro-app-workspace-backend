import { z } from 'zod';

/**
 * Login. Exigir `string` frena la inyección de operadores Mongo
 * (`{"$ne": null}` falla aquí y nunca llega a la consulta).
 */
export const loginSchema = z.strictObject({
  email: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(256),
});

export type LoginDto = z.infer<typeof loginSchema>;
