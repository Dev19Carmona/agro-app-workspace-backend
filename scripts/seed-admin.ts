// Crea el primer ADMIN de Mini-Croper. El registro público nunca crea ADMIN.
//
//   ADMIN_EMAIL=admin@correo.com ADMIN_PASSWORD='...' npm run seed:admin
//
// Lee también MONGODB_URI (de `.env` o del entorno). No tiene credenciales por
// defecto. Es idempotente: si ese email ya es ADMIN no hace nada; si pertenece
// a otro rol, falla sin tocarlo. Node ejecuta este archivo directamente (quita
// los tipos), así que solo importa módulos sin decoradores ni sintaxis de TS
// que requiera transformación.
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  BCRYPT_COST,
  checkPasswordPolicy,
} from '../apps/api/src/modules/auth/password.policy.ts';

/** Misma base y colección que el módulo `auth` del monolito `api`. */
const DB_NAME = 'mini-croper';
const USERS_COLLECTION = 'users';
/** Versión del texto de Habeas Data (igual a `CONSENT_VERSION` de `AuthService`). */
const CONSENT_VERSION = '1';

/** Error esperado (entrada inválida, conflicto): se muestra sin traza. */
export class SeedError extends Error {}

export type SeedInput = { email: string; password: string };

/** Lee y valida `ADMIN_EMAIL` y `ADMIN_PASSWORD`. Nunca incluye la contraseña en los errores. */
export function readSeedInput(
  env: Record<string, string | undefined>,
): SeedInput {
  const rawEmail = env.ADMIN_EMAIL?.trim();
  const password = env.ADMIN_PASSWORD;
  if (!rawEmail) throw new SeedError('Falta la variable ADMIN_EMAIL');
  if (!password) throw new SeedError('Falta la variable ADMIN_PASSWORD');

  const email = z.email().max(254).safeParse(rawEmail.toLowerCase());
  if (!email.success) {
    throw new SeedError('ADMIN_EMAIL no es un email válido');
  }

  const problems = checkPasswordPolicy(password, email.data);
  if (problems.length > 0) {
    throw new SeedError(
      `ADMIN_PASSWORD incumple la política:\n  - ${problems.join('\n  - ')}`,
    );
  }
  return { email: email.data, password };
}

/** Documento `users` del ADMIN, con la misma forma que escribe Mongoose. */
export function buildAdminDocument(
  email: string,
  passwordHash: string,
  now = new Date(),
) {
  return {
    email,
    passwordHash,
    nombre: 'Administrador',
    documento: 'ADMIN-SEED',
    rol: 'ADMIN',
    status: 'ACTIVE',
    consent: { acceptedAt: now, version: CONSENT_VERSION },
    failedLoginAttempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** Lo mínimo que se usa de una colección de MongoDB. */
export type UsersCollection = {
  findOne(filter: { email: string }): Promise<{ rol?: string } | null>;
  insertOne(doc: object): Promise<unknown>;
};

export type SeedResult = 'created' | 'exists';

/**
 * Crea el ADMIN si no existe. `hash` se calcula solo si hace falta (bcrypt
 * cuesta). Una clave duplicada por una carrera cuenta como «ya existe».
 */
export async function seedAdmin(
  users: UsersCollection,
  email: string,
  hash: () => Promise<string>,
): Promise<SeedResult> {
  const existing = await users.findOne({ email });
  if (existing) return assertIsAdmin(existing, email);

  try {
    await users.insertOne(buildAdminDocument(email, await hash()));
    return 'created';
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 11000) {
      return assertIsAdmin((await users.findOne({ email })) ?? {}, email);
    }
    throw error;
  }
}

function assertIsAdmin(user: { rol?: string }, email: string): SeedResult {
  if (user.rol !== 'ADMIN') {
    throw new SeedError(
      `${email} ya existe con otro rol; no se modifica. Usa otro email, o promuévelo con PATCH /auth/users/:id/role.`,
    );
  }
  return 'exists';
}

async function main(): Promise<number> {
  let input: SeedInput;
  try {
    input = readSeedInput(process.env);
  } catch (error) {
    if (error instanceof SeedError) {
      console.error(`seed:admin: ${error.message}`);
      return 1;
    }
    throw error;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('seed:admin: falta la variable MONGODB_URI');
    return 1;
  }

  await mongoose.connect(uri, { dbName: DB_NAME });
  try {
    const users = mongoose.connection.collection(USERS_COLLECTION);
    // Mismo índice único que declara el schema; garantiza que no se duplique
    // aunque `api` aún no haya arrancado nunca.
    await users.createIndex({ email: 1 }, { unique: true });

    const result = await seedAdmin(users as UsersCollection, input.email, () =>
      bcrypt.hash(input.password, BCRYPT_COST),
    );
    console.log(
      result === 'created'
        ? `seed:admin: ADMIN creado (${input.email})`
        : `seed:admin: ${input.email} ya es ADMIN; no se hicieron cambios`,
    );
    return 0;
  } catch (error) {
    if (error instanceof SeedError) {
      console.error(`seed:admin: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    await mongoose.disconnect();
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
