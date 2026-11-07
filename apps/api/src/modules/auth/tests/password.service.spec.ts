import { BadRequestException } from '@nestjs/common';
import bcrypt from 'bcrypt';
import {
  checkPasswordPolicy,
  PASSWORD_MAX_BYTES,
} from '../policies/password.policy.js';
import { PasswordService } from '../services/password.service.js';

const VALIDA = 'Segura12345';

describe('checkPasswordPolicy', () => {
  it('acepta una contraseña válida', () => {
    expect(checkPasswordPolicy(VALIDA, 'ana@correo.com')).toEqual([]);
  });

  it('acepta exactamente 10 caracteres', () => {
    expect(checkPasswordPolicy('Abcdefgh12')).toEqual([]);
  });

  it('rechaza 9 caracteres', () => {
    expect(checkPasswordPolicy('Abcdefg12')).toEqual([
      expect.stringContaining('al menos 10'),
    ]);
  });

  it('rechaza más de 72 bytes', () => {
    const larga = 'Aa1' + 'x'.repeat(PASSWORD_MAX_BYTES);
    expect(checkPasswordPolicy(larga)).toEqual([
      expect.stringContaining('72 bytes'),
    ]);
  });

  it('cuenta bytes y no caracteres: 40 emojis superan 72 bytes', () => {
    const emojis = 'Aa1' + '😀'.repeat(40); // 43 "caracteres" pero 163 bytes
    expect(checkPasswordPolicy(emojis)).toEqual([
      expect.stringContaining('72 bytes'),
    ]);
  });

  it('acepta exactamente 72 bytes', () => {
    expect(checkPasswordPolicy('Aa1' + 'x'.repeat(69))).toEqual([]);
  });

  it('exige mayúscula', () => {
    expect(checkPasswordPolicy('segura12345')).toEqual([
      expect.stringContaining('mayúscula'),
    ]);
  });

  it('exige minúscula', () => {
    expect(checkPasswordPolicy('SEGURA12345')).toEqual([
      expect.stringContaining('minúscula'),
    ]);
  });

  it('exige número', () => {
    expect(checkPasswordPolicy('SeguraSegura')).toEqual([
      expect.stringContaining('número'),
    ]);
  });

  it('rechaza una contraseña que contiene el email, sin distinguir mayúsculas', () => {
    expect(checkPasswordPolicy('xAna@Correo.com9', 'ana@correo.com')).toEqual([
      expect.stringContaining('email'),
    ]);
  });

  it('acumula todos los incumplimientos', () => {
    expect(checkPasswordPolicy('abc')).toHaveLength(3);
  });
});

describe('PasswordService', () => {
  const service = new PasswordService();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('assertPolicy', () => {
    it('no lanza con una contraseña válida', () => {
      expect(() =>
        service.assertPolicy(VALIDA, 'ana@correo.com'),
      ).not.toThrow();
    });

    it('lanza 400 con los incumplimientos', () => {
      expect(() => service.assertPolicy('abc')).toThrow(BadRequestException);
    });
  });

  describe('hash y compare', () => {
    it('genera un hash bcrypt de costo 12 distinto de la contraseña', async () => {
      const hash = await service.hash(VALIDA);
      expect(hash).toMatch(/^\$2[aby]\$12\$/);
      expect(hash).not.toContain(VALIDA);
    });

    it('usa sal: dos hashes de la misma contraseña difieren', async () => {
      expect(await service.hash(VALIDA)).not.toBe(await service.hash(VALIDA));
    });

    it('compara bien una contraseña correcta y una incorrecta', async () => {
      const hash = await service.hash(VALIDA);
      await expect(service.compare(VALIDA, hash)).resolves.toBe(true);
      await expect(service.compare('Otra123456', hash)).resolves.toBe(false);
    });
  });

  describe('compare sin usuario', () => {
    it('devuelve false y aun así ejecuta bcrypt contra un hash falso de costo 12', async () => {
      const spy = vi.spyOn(bcrypt, 'compare');
      await expect(service.compare(VALIDA, undefined)).resolves.toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toMatch(/^\$2[aby]\$12\$/);
    });

    it('nunca devuelve true aunque coincida con alguna contraseña', async () => {
      await expect(service.compare('', undefined)).resolves.toBe(false);
    });
  });
});
