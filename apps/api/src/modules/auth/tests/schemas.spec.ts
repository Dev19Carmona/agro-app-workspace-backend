import { model, Types } from 'mongoose';
import { Role } from '../../../../../../libs/common/src/security/roles.js';
import { RefreshTokenSchema } from './refresh-token.schema.js';
import { UserSchema, UserStatus } from './user.schema.js';

type Indice = [Record<string, number>, Record<string, unknown>];
const indices = (schema: { indexes(): unknown[] }) =>
  schema.indexes() as Indice[];

const UserModel = model('UserSpec', UserSchema);
const RefreshModel = model('RefreshSpec', RefreshTokenSchema);

const usuario: Record<string, unknown> = {
  email: '  Ana@Correo.COM ',
  passwordHash: 'hash',
  nombre: 'Ana',
  documento: '123456',
  rol: Role.PRODUCTOR,
  status: UserStatus.ACTIVE,
  consent: { acceptedAt: new Date(), version: '1' },
};

const sin = (obj: Record<string, unknown>, campo: string) =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => k !== campo));

describe('UserSchema', () => {
  it('tiene índice único por email', () => {
    expect(indices(UserSchema)).toContainEqual([
      { email: 1 },
      expect.objectContaining({ unique: true }),
    ]);
  });

  it('normaliza el email a minúsculas sin espacios', () => {
    expect(new UserModel(usuario).email).toBe('ana@correo.com');
  });

  it('inicia failedLoginAttempts en 0 y sin storeId ni lockedUntil', () => {
    const doc = new UserModel(usuario);
    expect(doc.failedLoginAttempts).toBe(0);
    expect(doc.storeId).toBeUndefined();
    expect(doc.lockedUntil).toBeUndefined();
  });

  it('es válido con los campos obligatorios', () => {
    expect(new UserModel(usuario).validateSync()).toBeUndefined();
  });

  it.each([
    'email',
    'passwordHash',
    'nombre',
    'documento',
    'rol',
    'status',
    'consent',
  ])('exige %s', (campo) => {
    const error = new UserModel(sin(usuario, campo)).validateSync();
    expect(error?.errors[campo]).toBeDefined();
  });

  it('rechaza un rol o status fuera del enum', () => {
    const error = new UserModel({
      ...usuario,
      rol: 'SUPERUSUARIO',
      status: 'OTRO',
    }).validateSync();
    expect(error?.errors.rol).toBeDefined();
    expect(error?.errors.status).toBeDefined();
  });

  it('no incluye passwordHash en las consultas por defecto', () => {
    expect(UserSchema.path('passwordHash').options.select).toBe(false);
  });

  it('agrega createdAt y updatedAt', () => {
    expect(UserSchema.get('timestamps')).toBe(true);
  });
});

describe('RefreshTokenSchema', () => {
  const token: Record<string, unknown> = {
    userId: new Types.ObjectId(),
    familyId: 'fam-1',
    tokenHash: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 1000),
  };

  it('tiene índice único por tokenHash', () => {
    expect(indices(RefreshTokenSchema)).toContainEqual([
      { tokenHash: 1 },
      expect.objectContaining({ unique: true }),
    ]);
  });

  it('tiene índice TTL en expiresAt', () => {
    expect(indices(RefreshTokenSchema)).toContainEqual([
      { expiresAt: 1 },
      expect.objectContaining({ expireAfterSeconds: 0 }),
    ]);
  });

  it('indexa userId y familyId', () => {
    const claves = indices(RefreshTokenSchema).map(([k]) => Object.keys(k)[0]);
    expect(claves).toEqual(expect.arrayContaining(['userId', 'familyId']));
  });

  it('es válido con los campos obligatorios', () => {
    expect(new RefreshModel(token).validateSync()).toBeUndefined();
  });

  it.each(['userId', 'familyId', 'tokenHash', 'expiresAt'])(
    'exige %s',
    (campo) => {
      const error = new RefreshModel(sin(token, campo)).validateSync();
      expect(error?.errors[campo]).toBeDefined();
    },
  );

  it('no guarda un token en claro: solo tokenHash', () => {
    expect(Object.keys(RefreshTokenSchema.paths)).not.toContain('token');
  });
});
