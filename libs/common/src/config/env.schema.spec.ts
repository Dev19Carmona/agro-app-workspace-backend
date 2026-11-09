import { generateKeyPairSync } from 'node:crypto';
import { validateApiEnv, validateEnv } from './env.schema.js';

const URI = 'mongodb://localhost:27017/?replicaSet=rs0&directConnection=true';
const AMQP = 'amqp://mini-croper:mini-croper-dev@localhost:5672';
const TOKEN = 't'.repeat(32);

describe('validateEnv', () => {
  it('acepta una MONGODB_URI válida', () => {
    expect(
      validateEnv({
        MONGODB_URI: URI,
        RABBITMQ_URI: AMQP,
        INTERNAL_SERVICE_TOKEN: TOKEN,
      }),
    ).toEqual({
      MONGODB_URI: URI,
      RABBITMQ_URI: AMQP,
      INTERNAL_SERVICE_TOKEN: TOKEN,
    });
  });

  it('convierte PORT a número', () => {
    expect(
      validateEnv({
        MONGODB_URI: URI,
        RABBITMQ_URI: AMQP,
        INTERNAL_SERVICE_TOKEN: TOKEN,
        PORT: '3000',
      }).PORT,
    ).toBe(3000);
  });

  it('rechaza si falta MONGODB_URI y nombra la variable', () => {
    expect(() => validateEnv({})).toThrow(/MONGODB_URI/);
  });

  it('rechaza una MONGODB_URI que no es una URL', () => {
    expect(() =>
      validateEnv({
        MONGODB_URI: 'no-es-una-url',
        RABBITMQ_URI: AMQP,
        INTERNAL_SERVICE_TOKEN: TOKEN,
      }),
    ).toThrow(/MONGODB_URI/);
  });

  it('rechaza si falta RABBITMQ_URI y nombra la variable', () => {
    expect(() =>
      validateEnv({ MONGODB_URI: URI, INTERNAL_SERVICE_TOKEN: TOKEN }),
    ).toThrow(/RABBITMQ_URI/);
  });

  it('rechaza una RABBITMQ_URI con esquema distinto de amqp(s)://', () => {
    expect(() =>
      validateEnv({
        MONGODB_URI: URI,
        RABBITMQ_URI: 'http://localhost:5672',
        INTERNAL_SERVICE_TOKEN: TOKEN,
      }),
    ).toThrow(/RABBITMQ_URI/);
  });

  it('acepta una RABBITMQ_URI amqps://', () => {
    expect(
      validateEnv({
        MONGODB_URI: URI,
        RABBITMQ_URI: 'amqps://host:5671',
        INTERNAL_SERVICE_TOKEN: TOKEN,
      }).RABBITMQ_URI,
    ).toBe('amqps://host:5671');
  });

  it('rechaza un PORT que no es número y nombra la variable', () => {
    expect(() =>
      validateEnv({
        MONGODB_URI: URI,
        RABBITMQ_URI: AMQP,
        INTERNAL_SERVICE_TOKEN: TOKEN,
        PORT: 'abc',
      }),
    ).toThrow(/PORT/);
  });

  it('rechaza si falta INTERNAL_SERVICE_TOKEN y nombra la variable', () => {
    expect(() => validateEnv({ MONGODB_URI: URI, RABBITMQ_URI: AMQP })).toThrow(
      /INTERNAL_SERVICE_TOKEN/,
    );
  });

  it('rechaza un INTERNAL_SERVICE_TOKEN de menos de 32 caracteres', () => {
    expect(() =>
      validateEnv({
        MONGODB_URI: URI,
        RABBITMQ_URI: AMQP,
        INTERNAL_SERVICE_TOKEN: 't'.repeat(31),
      }),
    ).toThrow(/INTERNAL_SERVICE_TOKEN/);
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
    RABBITMQ_URI: AMQP,
    JWT_PRIVATE_KEY: privateKey,
    JWT_PUBLIC_KEY: publicKey,
    PAYMENTS_WEBHOOK_SECRET: SECRET,
    INTERNAL_SERVICE_TOKEN: TOKEN,
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
      validateApiEnv({
        ...base,
        JWT_PRIVATE_KEY: undefined,
      }),
    ).toThrow(/JWT_PRIVATE_KEY/);
  });

  it('rechaza si falta JWT_PUBLIC_KEY y nombra la variable', () => {
    expect(() =>
      validateApiEnv({
        ...base,
        JWT_PUBLIC_KEY: undefined,
      }),
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

  it('rechaza si falta INTERNAL_SERVICE_TOKEN en api y nombra la variable', () => {
    const { INTERNAL_SERVICE_TOKEN: _omitido, ...sinToken } = base;
    expect(() => validateApiEnv(sinToken)).toThrow(/INTERNAL_SERVICE_TOKEN/);
  });

  it('NOTIFICATIONS_INTERNAL_URL ausente usa http://localhost:3005', () => {
    expect(validateApiEnv(base).NOTIFICATIONS_INTERNAL_URL).toBe(
      'http://localhost:3005',
    );
  });

  it('acepta una NOTIFICATIONS_INTERNAL_URL válida', () => {
    expect(
      validateApiEnv({
        ...base,
        NOTIFICATIONS_INTERNAL_URL: 'http://notifications:3005',
      }).NOTIFICATIONS_INTERNAL_URL,
    ).toBe('http://notifications:3005');
  });

  it('rechaza una NOTIFICATIONS_INTERNAL_URL inválida y nombra la variable', () => {
    expect(() =>
      validateApiEnv({ ...base, NOTIFICATIONS_INTERNAL_URL: 'no-es-url' }),
    ).toThrow(/NOTIFICATIONS_INTERNAL_URL/);
  });
});
