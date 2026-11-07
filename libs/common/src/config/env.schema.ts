import { z } from 'zod';

/** Variables de entorno compartidas por las apps del workspace. */
export const envSchema = z.object({
  MONGODB_URI: z.url(),
  PORT: z.coerce.number().int().positive().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Valida `process.env` al arrancar (se pasa a `ConfigModule.forRoot({ validate })`).
 * Si falta o es inválida alguna variable, lanza un error que nombra cada una.
 */
export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const detalle = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Variables de entorno inválidas: ${detalle}`);
  }
  return result.data;
}
