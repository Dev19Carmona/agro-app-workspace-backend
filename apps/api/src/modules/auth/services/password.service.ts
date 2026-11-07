import { BadRequestException, Injectable } from '@nestjs/common';
import bcrypt from 'bcrypt';
import { BCRYPT_COST, checkPasswordPolicy } from './password.policy.js';

/**
 * Hash bcrypt válido (costo 12) de una contraseña que nadie conoce. Se compara
 * cuando el usuario no existe, para que el login tarde igual que con un usuario real.
 */
const DUMMY_HASH =
  '$2b$12$eH.vAKRDAR0X17x4T2xlX.E4GQleHFJy28y5h6VtIdXzpK2BVbLrO';

@Injectable()
export class PasswordService {
  /** Lanza 400 si la contraseña incumple la política. */
  assertPolicy(password: string, email?: string): void {
    const errors = checkPasswordPolicy(password, email);
    if (errors.length > 0) {
      throw new BadRequestException(errors);
    }
  }

  hash(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_COST);
  }

  /**
   * Compara la contraseña con el hash guardado. Si no hay hash (usuario
   * inexistente) compara contra un hash falso para igualar tiempos y devuelve `false`.
   */
  async compare(password: string, hash?: string): Promise<boolean> {
    if (!hash) {
      await bcrypt.compare(password, DUMMY_HASH);
      return false;
    }
    return bcrypt.compare(password, hash);
  }
}
