import { validateEnv } from './env.schema.js';

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
