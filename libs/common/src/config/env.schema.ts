import { createPrivateKey, createPublicKey } from 'node:crypto';
import { z } from 'zod';

/** Variables de entorno compartidas por las apps del workspace. */
export const envSchema = z.object({
  MONGODB_URI: z.url(),
  RABBITMQ_URI: z.string().regex(/^amqps?:\/\//),
  PORT: z.coerce.number().int().positive().optional(),
});

export type Env = z.infer<typeof envSchema>;

const MIN_RSA_BITS = 2048;

/** Los PEM en `.env` suelen venir en una línea con `\n` escapados. */
function normalizePem(value: string): string {
  return value.replace(/\\n/g, '\n').trim();
}

/** PEM RSA (privada o pública) de al menos 2048 bits, con `\n` escapados normalizados. */
function rsaPem(kind: 'private' | 'public') {
  return z
    .string()
    .min(1)
    .transform(normalizePem)
    .superRefine((pem, ctx) => {
      try {
        const key =
          kind === 'private' ? createPrivateKey(pem) : createPublicKey(pem);
        if (key.asymmetricKeyType !== 'rsa') {
          ctx.addIssue({ code: 'custom', message: 'debe ser una clave RSA' });
          return;
        }
        const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
        if (bits < MIN_RSA_BITS) {
          ctx.addIssue({
            code: 'custom',
            message: `la clave RSA debe tener al menos ${MIN_RSA_BITS} bits`,
          });
        }
      } catch {
        ctx.addIssue({ code: 'custom', message: 'no es un PEM válido' });
      }
    });
}

/**
 * Variables de entorno del monolito `api`: las comunes más la seguridad.
 * Es un schema aparte para no exigir claves JWT a `notifications`.
 */
export const apiEnvSchema = envSchema.extend({
  JWT_PRIVATE_KEY: rsaPem('private'),
  JWT_PUBLIC_KEY: rsaPem('public'),
  PAYMENTS_WEBHOOK_SECRET: z.string().min(32),
  CORS_ORIGINS: z.string().optional(),
  NODE_ENV: z.string().optional(),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

function parseOrThrow<T>(schema: z.ZodType<T>, config: unknown): T {
  const result = schema.safeParse(config);
  if (!result.success) {
    const detalle = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Variables de entorno inválidas: ${detalle}`);
  }
  return result.data;
}

/**
 * Valida `process.env` al arrancar (se pasa a `ConfigModule.forRoot({ validate })`).
 * Si falta o es inválida alguna variable, lanza un error que nombra cada una.
 */
export function validateEnv(config: Record<string, unknown>): Env {
  return parseOrThrow(envSchema, config);
}

/** Igual que `validateEnv`, pero con las variables de seguridad de `api`. */
export function validateApiEnv(config: Record<string, unknown>): ApiEnv {
  return parseOrThrow(apiEnvSchema, config);
}
