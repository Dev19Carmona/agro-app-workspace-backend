import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';
import {
  type AccessTokenPayload,
  type Role,
} from '../../../../../../libs/common/src/security/roles.js';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from '../../../../../../libs/common/src/security/security.constants.js';
import {
  RefreshToken,
  type RefreshTokenDocument,
} from '../schemas/refresh-token.schema.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type AccessTokenSubject = {
  userId: string;
  rol: Role;
  /** Sesión: coincide con la familia de refresh tokens. */
  sessionId: string;
  storeId?: string;
};

export type IssuedRefreshToken = {
  /** Token opaco en claro: solo se entrega al cliente, nunca se guarda. */
  token: string;
  expiresAt: Date;
};

export type RotationResult = IssuedRefreshToken & {
  userId: string;
  familyId: string;
};

type StoredRefreshToken = RefreshToken & { _id: Types.ObjectId };

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Access token RS256 y refresh token opaco con rotación y detección de reuso. */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @InjectModel(RefreshToken.name)
    private readonly refreshModel: Model<RefreshTokenDocument>,
  ) {}

  /** Firma el access token (15 min). No lleva email ni documento. */
  signAccessToken(subject: AccessTokenSubject): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: subject.userId,
      rol: subject.rol,
      sid: subject.sessionId,
      ...(subject.storeId && { storeId: subject.storeId }),
    };
    return this.jwt.signAsync(payload, {
      algorithm: JWT_ALGORITHM,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });
  }

  /** Nueva sesión: refresh token en una familia nueva. */
  startSession(
    userId: string,
  ): Promise<IssuedRefreshToken & { familyId: string }> {
    const familyId = randomUUID();
    return this.issueRefreshToken(userId, familyId).then((issued) => ({
      ...issued,
      familyId,
    }));
  }

  /**
   * Canjea un refresh token por otro nuevo de la misma familia y revoca el
   * anterior. Si el token ya estaba usado o revocado se asume robo: se revoca
   * toda la familia. Cualquier fallo responde igual: 401.
   */
  async rotate(refreshToken: string): Promise<RotationResult> {
    const stored = await this.refreshModel
      .findOne({ tokenHash: sha256(refreshToken) })
      .lean<StoredRefreshToken>();
    if (!stored) throw this.invalid();

    if (stored.revokedAt) {
      await this.revokeFamily(stored.familyId);
      throw this.invalid();
    }
    if (stored.expiresAt.getTime() <= Date.now()) throw this.invalid();

    // Reclamo atómico: si dos peticiones llegan a la vez, solo una gana.
    const claimed = await this.refreshModel.findOneAndUpdate(
      { _id: stored._id, revokedAt: null },
      { revokedAt: new Date() },
    );
    if (!claimed) {
      await this.revokeFamily(stored.familyId);
      throw this.invalid();
    }

    const userId = stored.userId.toString();
    const next = await this.issueRefreshToken(userId, stored.familyId);
    await this.refreshModel.updateOne(
      { _id: stored._id },
      { replacedBy: next.id },
    );
    return {
      token: next.token,
      expiresAt: next.expiresAt,
      userId,
      familyId: stored.familyId,
    };
  }

  /** Cierra una sesión: revoca todos los refresh tokens de la familia. */
  async revokeFamily(familyId: string): Promise<void> {
    await this.refreshModel.updateMany(
      { familyId, revokedAt: null },
      { revokedAt: new Date() },
    );
  }

  /** Cierra todas las sesiones del usuario. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.refreshModel.updateMany(
      { userId: new Types.ObjectId(userId), revokedAt: null },
      { revokedAt: new Date() },
    );
  }

  private async issueRefreshToken(
    userId: string,
    familyId: string,
  ): Promise<IssuedRefreshToken & { id: Types.ObjectId }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    const created = await this.refreshModel.create({
      userId: new Types.ObjectId(userId),
      familyId,
      tokenHash: sha256(token),
      expiresAt,
    });
    return { token, expiresAt, id: created._id };
  }

  private invalid(): UnauthorizedException {
    return new UnauthorizedException('Refresh token inválido');
  }
}
