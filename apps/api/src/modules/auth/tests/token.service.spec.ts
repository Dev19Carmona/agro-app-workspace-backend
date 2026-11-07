import { createHash, generateKeyPairSync } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';
import { Role } from '../../../../../../libs/common/src/security/roles.js';
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
} from '../../../../../../libs/common/src/security/security.constants.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_MS,
  TokenService,
} from '../services/token.service.js';

type Doc = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  revokedAt?: Date | null;
  replacedBy?: Types.ObjectId;
};

/** Modelo en memoria con solo las operaciones que usa `TokenService`. */
function crearModeloFalso() {
  const docs: Doc[] = [];
  const sinRevocar = (d: Doc) => !d.revokedAt;
  const modelo = {
    docs,
    create: vi.fn(async (data: Omit<Doc, '_id' | 'createdAt'>) => {
      const doc = { _id: new Types.ObjectId(), createdAt: new Date(), ...data };
      docs.push(doc);
      return doc;
    }),
    findOne: vi.fn((filtro: { tokenHash: string }) => ({
      lean: async () =>
        docs.find((d) => d.tokenHash === filtro.tokenHash) ?? null,
    })),
    findOneAndUpdate: vi.fn(
      async (filtro: { _id: Types.ObjectId }, cambio: Partial<Doc>) => {
        const doc = docs.find((d) => d._id.equals(filtro._id) && sinRevocar(d));
        if (!doc) return null;
        const original = { ...doc };
        Object.assign(doc, cambio);
        return original;
      },
    ),
    updateOne: vi.fn(
      async (filtro: { _id: Types.ObjectId }, cambio: Partial<Doc>) => {
        Object.assign(docs.find((d) => d._id.equals(filtro._id)) ?? {}, cambio);
      },
    ),
    updateMany: vi.fn(
      async (
        filtro: { familyId?: string; userId?: Types.ObjectId },
        cambio: Partial<Doc>,
      ) => {
        for (const d of docs) {
          const coincide =
            sinRevocar(d) &&
            (filtro.familyId === undefined || d.familyId === filtro.familyId) &&
            (filtro.userId === undefined || d.userId.equals(filtro.userId));
          if (coincide) Object.assign(d, cambio);
        }
      },
    ),
  };
  return modelo;
}

const par = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describe('TokenService', () => {
  const userId = new Types.ObjectId().toString();
  let modelo: ReturnType<typeof crearModeloFalso>;
  let service: TokenService;
  const verificador = new JwtService({ publicKey: par.publicKey });

  beforeEach(() => {
    modelo = crearModeloFalso();
    service = new TokenService(
      new JwtService({ privateKey: par.privateKey }),
      modelo as never,
    );
  });

  describe('signAccessToken', () => {
    it('firma RS256 con exp − iat = 900, iss y aud fijos', async () => {
      const token = await service.signAccessToken({
        userId,
        rol: Role.PRODUCTOR,
        sessionId: 'fam-1',
      });
      const { header, payload } = verificador.decode(token, {
        complete: true,
      });
      expect(header.alg).toBe('RS256');
      expect(payload.exp - payload.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
      expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
      expect(payload).toMatchObject({
        sub: userId,
        rol: Role.PRODUCTOR,
        sid: 'fam-1',
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
      });
    });

    it('no contiene email ni documento y solo incluye storeId si existe', async () => {
      const sin = verificador.decode(
        await service.signAccessToken({
          userId,
          rol: Role.PROVEEDOR,
          sessionId: 's',
        }),
      );
      expect(Object.keys(sin).sort()).toEqual(
        ['aud', 'exp', 'iat', 'iss', 'rol', 'sid', 'sub'].sort(),
      );

      const con = verificador.decode(
        await service.signAccessToken({
          userId,
          rol: Role.PROVEEDOR,
          sessionId: 's',
          storeId: 'st1',
        }),
      );
      expect(con.storeId).toBe('st1');
    });

    it('el token se verifica con la clave pública', async () => {
      const token = await service.signAccessToken({
        userId,
        rol: Role.ADMIN,
        sessionId: 's',
      });
      await expect(
        verificador.verifyAsync(token, {
          algorithms: ['RS256'],
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        }),
      ).resolves.toMatchObject({ sub: userId });
    });
  });

  describe('startSession', () => {
    it('guarda solo el hash SHA-256: el token en claro no está en la base', async () => {
      const { token, familyId, expiresAt } = await service.startSession(userId);

      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes en base64url
      expect(modelo.docs).toHaveLength(1);
      expect(modelo.docs[0].tokenHash).toBe(sha256(token));
      expect(modelo.docs[0].familyId).toBe(familyId);
      expect(JSON.stringify(modelo.docs)).not.toContain(token);
      expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(
        REFRESH_TOKEN_TTL_MS - 5_000,
      );
    });

    it('cada sesión usa una familia y un token distintos', async () => {
      const a = await service.startSession(userId);
      const b = await service.startSession(userId);
      expect(a.familyId).not.toBe(b.familyId);
      expect(a.token).not.toBe(b.token);
    });
  });

  describe('rotate', () => {
    it('rotación normal: devuelve un token nuevo de la misma familia y revoca el anterior', async () => {
      const inicial = await service.startSession(userId);
      const rotado = await service.rotate(inicial.token);

      expect(rotado.token).not.toBe(inicial.token);
      expect(rotado.userId).toBe(userId);
      expect(rotado.familyId).toBe(inicial.familyId);

      const [viejo, nuevo] = modelo.docs;
      expect(viejo.revokedAt).toBeInstanceOf(Date);
      expect(viejo.replacedBy).toEqual(nuevo._id);
      expect(nuevo.revokedAt).toBeUndefined();
      expect(nuevo.tokenHash).toBe(sha256(rotado.token));
    });

    it('permite encadenar rotaciones con el token más reciente', async () => {
      const inicial = await service.startSession(userId);
      const segundo = await service.rotate(inicial.token);
      await expect(service.rotate(segundo.token)).resolves.toMatchObject({
        familyId: inicial.familyId,
      });
    });

    it('reuso: reutilizar el token anterior da 401 y revoca toda la familia', async () => {
      const inicial = await service.startSession(userId);
      const rotado = await service.rotate(inicial.token);

      await expect(service.rotate(inicial.token)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(modelo.docs.every((d) => d.revokedAt)).toBe(true);

      // El refresh nuevo también dejó de servir.
      await expect(service.rotate(rotado.token)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('el reuso no afecta a otras sesiones del mismo usuario', async () => {
      const a = await service.startSession(userId);
      const b = await service.startSession(userId);
      await service.rotate(a.token);
      await expect(service.rotate(a.token)).rejects.toThrow();

      await expect(service.rotate(b.token)).resolves.toMatchObject({
        familyId: b.familyId,
      });
    });

    it('expirado: responde 401 y no rota', async () => {
      const inicial = await service.startSession(userId);
      modelo.docs[0].expiresAt = new Date(Date.now() - 1000);

      await expect(service.rotate(inicial.token)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(modelo.docs).toHaveLength(1);
      expect(modelo.docs[0].revokedAt).toBeUndefined();
    });

    it('revocado (p. ej. tras logout): responde 401', async () => {
      const inicial = await service.startSession(userId);
      await service.revokeFamily(inicial.familyId);

      await expect(service.rotate(inicial.token)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('token desconocido: responde 401', async () => {
      await expect(service.rotate('no-existe')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('carrera: si el reclamo atómico pierde, responde 401 y revoca la familia', async () => {
      const inicial = await service.startSession(userId);
      modelo.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(service.rotate(inicial.token)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(modelo.docs.every((d) => d.revokedAt)).toBe(true);
      expect(modelo.docs).toHaveLength(1);
    });

    it('todos los fallos responden el mismo mensaje', async () => {
      const mensajes = new Set<string>();
      const inicial = await service.startSession(userId);
      await service.rotate(inicial.token);
      for (const token of ['no-existe', inicial.token]) {
        await service.rotate(token).catch((e: UnauthorizedException) => {
          mensajes.add(e.message);
        });
      }
      expect(mensajes.size).toBe(1);
    });
  });

  describe('revocación', () => {
    it('revokeFamily revoca solo esa familia', async () => {
      const a = await service.startSession(userId);
      const b = await service.startSession(userId);
      await service.revokeFamily(a.familyId);

      expect(modelo.docs[0].revokedAt).toBeInstanceOf(Date);
      expect(modelo.docs[1].revokedAt).toBeUndefined();
      await expect(service.rotate(b.token)).resolves.toBeDefined();
    });

    it('revokeAllForUser revoca todas las sesiones del usuario y no las de otros', async () => {
      const otro = new Types.ObjectId().toString();
      await service.startSession(userId);
      await service.startSession(userId);
      await service.startSession(otro);

      await service.revokeAllForUser(userId);

      const revocados = modelo.docs.map((d) => Boolean(d.revokedAt));
      expect(revocados).toEqual([true, true, false]);
    });
  });
});
