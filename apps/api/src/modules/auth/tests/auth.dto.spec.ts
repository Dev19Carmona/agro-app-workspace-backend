import { loginSchema } from '../dto/login.dto.js';
import { registerSchema } from '../dto/register.dto.js';

const registro = {
  email: 'Ana@Correo.com',
  password: 'Segura12345',
  nombre: 'Ana Pérez',
  documento: '1020304050',
  rol: 'PRODUCTOR',
  aceptaTratamientoDatos: true,
};

const sin = (obj: Record<string, unknown>, campo: string) =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => k !== campo));

describe('registerSchema', () => {
  it('acepta un registro válido y normaliza el email', () => {
    const r = registerSchema.safeParse(registro);
    expect(r.success).toBe(true);
    expect(r.data?.email).toBe('ana@correo.com');
  });

  it('acepta PROVEEDOR', () => {
    expect(
      registerSchema.safeParse({ ...registro, rol: 'PROVEEDOR' }).success,
    ).toBe(true);
  });

  it('rechaza rol ADMIN', () => {
    expect(
      registerSchema.safeParse({ ...registro, rol: 'ADMIN' }).success,
    ).toBe(false);
  });

  it.each(['status', 'storeId', 'passwordHash', 'failedLoginAttempts'])(
    'rechaza la propiedad desconocida %s (mass assignment)',
    (campo) => {
      expect(
        registerSchema.safeParse({ ...registro, [campo]: 'ACTIVE' }).success,
      ).toBe(false);
    },
  );

  it('rechaza sin aceptaTratamientoDatos', () => {
    expect(
      registerSchema.safeParse(sin(registro, 'aceptaTratamientoDatos')).success,
    ).toBe(false);
  });

  it.each([false, 'true', 1])(
    'rechaza aceptaTratamientoDatos = %s',
    (valor) => {
      expect(
        registerSchema.safeParse({
          ...registro,
          aceptaTratamientoDatos: valor,
        }).success,
      ).toBe(false);
    },
  );

  it.each(['email', 'password', 'nombre', 'documento', 'rol'])(
    'exige %s',
    (campo) => {
      expect(registerSchema.safeParse(sin(registro, campo)).success).toBe(
        false,
      );
    },
  );

  it('rechaza un email inválido', () => {
    expect(
      registerSchema.safeParse({ ...registro, email: 'no-es-email' }).success,
    ).toBe(false);
  });

  it('rechaza un email como objeto (inyección de operadores)', () => {
    expect(
      registerSchema.safeParse({ ...registro, email: { $ne: null } }).success,
    ).toBe(false);
  });

  it('rechaza un documento con caracteres raros', () => {
    expect(
      registerSchema.safeParse({ ...registro, documento: '12 3;$' }).success,
    ).toBe(false);
  });
});

describe('loginSchema', () => {
  it('acepta credenciales y normaliza el email', () => {
    const r = loginSchema.safeParse({
      email: ' Ana@Correo.com ',
      password: 'x',
    });
    expect(r.data).toEqual({ email: 'ana@correo.com', password: 'x' });
  });

  it('rechaza un email como objeto {"$ne": null}', () => {
    expect(
      loginSchema.safeParse({ email: { $ne: null }, password: 'x' }).success,
    ).toBe(false);
  });

  it('rechaza una contraseña como objeto {"$gt": ""}', () => {
    expect(
      loginSchema.safeParse({ email: 'a@b.co', password: { $gt: '' } }).success,
    ).toBe(false);
  });

  it('rechaza propiedades desconocidas', () => {
    expect(
      loginSchema.safeParse({ email: 'a@b.co', password: 'x', rol: 'ADMIN' })
        .success,
    ).toBe(false);
  });

  it('rechaza campos vacíos o ausentes', () => {
    expect(loginSchema.safeParse({ email: '', password: 'x' }).success).toBe(
      false,
    );
    expect(loginSchema.safeParse({ email: 'a@b.co' }).success).toBe(false);
  });
});
