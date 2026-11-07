import { model } from 'mongoose';
import {
  buildAdminDocument,
  readSeedInput,
  SeedError,
  seedAdmin,
  type UsersCollection,
} from '../../../../../../scripts/seed-admin.ts';
import { UserSchema } from '../schemas/user.schema.js';

const VALIDO = {
  ADMIN_EMAIL: 'Admin@Correo.com',
  ADMIN_PASSWORD: 'Segura12345',
};

describe('readSeedInput', () => {
  it('acepta credenciales válidas y normaliza el email', () => {
    expect(readSeedInput(VALIDO)).toEqual({
      email: 'admin@correo.com',
      password: 'Segura12345',
    });
  });

  it('no tiene credenciales por defecto: sin variables falla', () => {
    expect(() => readSeedInput({})).toThrow(SeedError);
  });

  it('nombra ADMIN_EMAIL si falta', () => {
    expect(() =>
      readSeedInput({ ADMIN_PASSWORD: VALIDO.ADMIN_PASSWORD }),
    ).toThrow(/ADMIN_EMAIL/);
  });

  it('nombra ADMIN_PASSWORD si falta o está vacía', () => {
    expect(() => readSeedInput({ ADMIN_EMAIL: VALIDO.ADMIN_EMAIL })).toThrow(
      /ADMIN_PASSWORD/,
    );
    expect(() => readSeedInput({ ...VALIDO, ADMIN_PASSWORD: '' })).toThrow(
      /ADMIN_PASSWORD/,
    );
  });

  it('rechaza un email inválido', () => {
    expect(() =>
      readSeedInput({ ...VALIDO, ADMIN_EMAIL: 'no-es-email' }),
    ).toThrow(/ADMIN_EMAIL/);
  });

  it.each([
    ['9 caracteres', 'Abcdefg12'],
    ['sin mayúscula', 'segura12345'],
    ['sin número', 'SeguraSegura'],
    ['más de 72 bytes', 'Aa1' + 'x'.repeat(80)],
    ['con el email', 'xadmin@correo.com1A'],
  ])(
    'rechaza una contraseña %s, con la misma política que el registro',
    (_c, pass) => {
      expect(() => readSeedInput({ ...VALIDO, ADMIN_PASSWORD: pass })).toThrow(
        /política/,
      );
    },
  );

  it('el error no revela la contraseña', () => {
    try {
      readSeedInput({ ...VALIDO, ADMIN_PASSWORD: 'secretoDebil' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('secretoDebil');
    }
  });
});

describe('buildAdminDocument', () => {
  const doc = buildAdminDocument('admin@correo.com', '$2b$12$hash');
  const UserModel = model('SeedSpecUser', UserSchema);

  it('es un ADMIN activo que pasa la validación del schema real de User', () => {
    expect(doc).toMatchObject({ rol: 'ADMIN', status: 'ACTIVE' });
    expect(new UserModel(doc).validateSync()).toBeUndefined();
  });

  it('guarda el consentimiento con fecha y el contador en 0', () => {
    expect(doc.consent.acceptedAt).toBeInstanceOf(Date);
    expect(doc.consent.version).toBe('1');
    expect(doc.failedLoginAttempts).toBe(0);
  });

  it('guarda solo el hash, nunca una contraseña', () => {
    expect(doc.passwordHash).toBe('$2b$12$hash');
    expect(doc).not.toHaveProperty('password');
  });
});

describe('seedAdmin', () => {
  /** Colección en memoria con unicidad por email, como el índice único real. */
  function coleccion(inicial: { email: string; rol: string }[] = []) {
    const docs = [...inicial];
    const col: UsersCollection & { docs: typeof docs } = {
      docs,
      findOne: vi.fn(
        async ({ email }) => docs.find((d) => d.email === email) ?? null,
      ),
      insertOne: vi.fn(async (doc) => {
        docs.push(doc as never);
      }),
    };
    return col;
  }
  const hash = vi.fn(async () => '$2b$12$hash');

  beforeEach(() => hash.mockClear());

  it('crea el ADMIN si no existe', async () => {
    const users = coleccion();

    await expect(seedAdmin(users, 'admin@correo.com', hash)).resolves.toBe(
      'created',
    );
    expect(users.docs).toHaveLength(1);
    expect(users.docs[0]).toMatchObject({ rol: 'ADMIN', status: 'ACTIVE' });
  });

  it('una segunda ejecución no lo duplica ni calcula el hash', async () => {
    const users = coleccion();
    await seedAdmin(users, 'admin@correo.com', hash);
    hash.mockClear();

    await expect(seedAdmin(users, 'admin@correo.com', hash)).resolves.toBe(
      'exists',
    );
    expect(users.docs).toHaveLength(1);
    expect(hash).not.toHaveBeenCalled();
  });

  it('si el email pertenece a otro rol falla y no lo modifica', async () => {
    const users = coleccion([{ email: 'ana@correo.com', rol: 'PRODUCTOR' }]);

    await expect(
      seedAdmin(users, 'ana@correo.com', hash),
    ).rejects.toBeInstanceOf(SeedError);
    // Sin inserciones ni cambios: la colección queda exactamente igual.
    expect(users.docs).toEqual([{ email: 'ana@correo.com', rol: 'PRODUCTOR' }]);
  });

  it('una clave duplicada por carrera cuenta como «ya existe»', async () => {
    const users = coleccion();
    users.findOne = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ rol: 'ADMIN' });
    users.insertOne = vi.fn().mockRejectedValue({ code: 11000 });

    await expect(seedAdmin(users, 'admin@correo.com', hash)).resolves.toBe(
      'exists',
    );
  });

  it('otros errores de Mongo se propagan', async () => {
    const users = coleccion();
    const error = new Error('conexión caída');
    users.insertOne = vi.fn().mockRejectedValue(error);

    await expect(seedAdmin(users, 'admin@correo.com', hash)).rejects.toBe(
      error,
    );
  });
});
