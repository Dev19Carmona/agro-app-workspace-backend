import { z } from 'zod';
import { Role } from '../../../../../../libs/common/src/security/roles.js';

/**
 * Registro público. `strictObject` rechaza propiedades desconocidas (mass
 * assignment: `status`, `storeId`...) y `z.enum` deja fuera a `ADMIN`.
 * La política de contraseña depende del email, así que la aplica `AuthService`.
 */
export const registerSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(1).max(256),
  nombre: z.string().trim().min(2).max(120),
  documento: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{5,20}$/, 'documento inválido'),
  rol: z.enum([Role.PRODUCTOR, Role.PROVEEDOR]),
  aceptaTratamientoDatos: z.literal(true, {
    error: 'Debes aceptar el tratamiento de datos',
  }),
});

export type RegisterDto = z.infer<typeof registerSchema>;
