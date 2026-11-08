import { generateKeyPairSync } from 'node:crypto';
import { validateApiEnv, validateEnv } from './env.schema.js';

const URI = 'mongodb://localhost:27017/?replicaSet=rs0&directConnection=true';

describe('validateEnv', () => {
  it('acepta una MONGODB_URI válida', () => {
    expect(validateEnv({ MONGODB_URI: URI })).toEqual({ MONGODB_URI: URI });
  });

  it('convierte PORT a número', () => {
    expect(validateEnv({ MONGODB_URI: URI, PORT: '3000' }).PORT).toBe(3000);
  });

  it('rechaza si falta MONGODB_URI y nombra la variable', () => {
    expect(() => validateEnv({})).toThrow(/MONGODB_URI/);
  });

  it('rechaza una MONGODB_URI que no es una URL', () => {
    expect(() => validateEnv({ MONGODB_URI: 'no-es-una-url' })).toThrow(
      /MONGODB_URI/,
    );
  });

  it('rechaza un PORT que no es número y nombra la variable', () => {
    expect(() => validateEnv({ MONGODB_URI: URI, PORT: 'abc' })).toThrow(
      /PORT/,
    );
  });
});

describe('validateApiEnv', () => {
  const SECRET = 'x'.repeat(32);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const weak = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const base = {
    MONGODB_URI: URI,
    JWT_PRIVATE_KEY: privateKey,
    JWT_PUBLIC_KEY: publicKey,
    PAYMENTS_WEBHOOK_SECRET: SECRET,
  };

  it('acepta un par PEM válido', () => {
    const env = validateApiEnv(base);
    expect(env.JWT_PRIVATE_KEY).toContain('BEGIN PRIVATE KEY');
    expect(env.JWT_PUBLIC_KEY).toContain('BEGIN PUBLIC KEY');
  });

  it('admite saltos de línea escapados como \n', () => {
    const env = validateApiEnv({
      ...base,
      JWT_PRIVATE_KEY: privateKey.trim().replace(/\n/g, '\\n'),
      JWT_PUBLIC_KEY: publicKey.trim().replace(/\n/g, '\\n'),
    });
    expect(env.JWT_PRIVATE_KEY).not.toContain('\\n');
    expect(env.JWT_PRIVATE_KEY).toContain('\n');
  });

  it('rechaza si falta JWT_PRIVATE_KEY y nombra la variable', () => {
    expect(() =>
      validateApiEnv({ MONGODB_URI: URI, JWT_PUBLIC_KEY: publicKey }),
    ).toThrow(/JWT_PRIVATE_KEY/);
  });

  it('rechaza si falta JWT_PUBLIC_KEY y nombra la variable', () => {
    expect(() =>
      validateApiEnv({ MONGODB_URI: URI, JWT_PRIVATE_KEY: privateKey }),
    ).toThrow(/JWT_PUBLIC_KEY/);
  });

  it('rechaza una clave RSA menor a 2048 bits', () => {
    expect(() =>
      validateApiEnv({ ...base, JWT_PRIVATE_KEY: weak.privateKey }),
    ).toThrow(/JWT_PRIVATE_KEY.*2048/);
  });

  it('rechaza un PEM inválido', () => {
    expect(() =>
      validateApiEnv({ ...base, JWT_PUBLIC_KEY: 'no-es-pem' }),
    ).toThrow(/JWT_PUBLIC_KEY/);
  });

  it('rechaza una clave que no es RSA', () => {
    const ec = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(() =>
      validateApiEnv({ ...base, JWT_PRIVATE_KEY: ec.privateKey }),
    ).toThrow(/RSA/);
  });

  it('acepta PAYMENTS_WEBHOOK_SECRET de 32 caracteres', () => {
    expect(validateApiEnv(base).PAYMENTS_WEBHOOK_SECRET).toBe(SECRET);
  });

  it('rechaza si falta PAYMENTS_WEBHOOK_SECRET y nombra la variable', () => {
    const { PAYMENTS_WEBHOOK_SECRET: _omitida, ...sinSecreto } = base;
    expect(() => validateApiEnv(sinSecreto)).toThrow(/PAYMENTS_WEBHOOK_SECRET/);
  });

  it('rechaza PAYMENTS_WEBHOOK_SECRET de menos de 32 caracteres', () => {
    expect(() =>
      validateApiEnv({ ...base, PAYMENTS_WEBHOOK_SECRET: 'x'.repeat(31) }),
    ).toThrow(/PAYMENTS_WEBHOOK_SECRET/);
  });

  it('CORS_ORIGINS y NODE_ENV son opcionales', () => {
    const env = validateApiEnv({
      ...base,
      CORS_ORIGINS: 'http://localhost:5173',
      NODE_ENV: 'production',
    });
    expect(env.CORS_ORIGINS).toBe('http://localhost:5173');
    expect(env.NODE_ENV).toBe('production');
  });
});
