/**
 * Política de contraseña y costo de bcrypt. Archivo sin decoradores ni
 * dependencias de Nest, para que también lo ejecute Node directamente
 * (`scripts/seed-admin.ts`).
 */

export const BCRYPT_COST = 12;
export const PASSWORD_MIN_LENGTH = 10;
/** Límite real de bcrypt: más allá se trunca en silencio. */
export const PASSWORD_MAX_BYTES = 72;

/**
 * Política de contraseña: 10 caracteres o más, máximo 72 bytes, con mayúscula,
 * minúscula y número, y sin contener el email. Devuelve los incumplimientos
 * (vacío si es válida). Es una función pura para reutilizarla fuera de Nest
 * (p. ej. en `seed:admin`).
 */
export function checkPasswordPolicy(
  password: string,
  email?: string,
): string[] {
  const errors: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.push(
      `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`,
    );
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    errors.push(`La contraseña no puede superar ${PASSWORD_MAX_BYTES} bytes`);
  }
  if (!/\p{Lu}/u.test(password)) {
    errors.push('La contraseña debe incluir una mayúscula');
  }
  if (!/\p{Ll}/u.test(password)) {
    errors.push('La contraseña debe incluir una minúscula');
  }
  if (!/\d/.test(password)) {
    errors.push('La contraseña debe incluir un número');
  }
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail && password.toLowerCase().includes(normalizedEmail)) {
    errors.push('La contraseña no puede contener el email');
  }
  return errors;
}
