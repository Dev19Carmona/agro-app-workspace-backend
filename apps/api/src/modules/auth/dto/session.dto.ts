import { z } from 'zod';

export const refreshSchema = z.strictObject({
  refreshToken: z.string().min(1).max(512),
});
export type RefreshDto = z.infer<typeof refreshSchema>;

/**
 * La política de la contraseña nueva depende del email del usuario, así que
 * la aplica `AuthService`; aquí solo se acota el tamaño y el tipo.
 */
export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;
