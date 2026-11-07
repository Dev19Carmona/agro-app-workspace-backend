import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, type Types } from 'mongoose';
import { Role } from '../../../../../libs/common/src/security/roles.js';
import { AuthEvents, type UserRegisteredEvent } from './auth.events.js';
import type { LoginDto } from './dto/login.dto.js';
import type { RegisterDto } from './dto/register.dto.js';
import type { ChangePasswordDto, RefreshDto } from './dto/session.dto.js';
import { PasswordService } from './password.service.js';
import { User, type UserDocument, UserStatus } from './schemas/user.schema.js';
import { ACCESS_TOKEN_TTL_SECONDS, TokenService } from './token.service.js';

/** Versión del texto de tratamiento de datos (Habeas Data) que acepta el usuario. */
export const CONSENT_VERSION = '1';
export const MAX_FAILED_LOGIN_ATTEMPTS = 5;
export const LOCK_DURATION_MS = 15 * 60 * 1000;

const INVALID_CREDENTIALS = 'Credenciales inválidas';

const STATUS_MESSAGES: Record<
  Exclude<UserStatus, UserStatus.ACTIVE>,
  string
> = {
  [UserStatus.PENDING_APPROVAL]:
    'Tu solicitud de proveedor está pendiente de aprobación',
  [UserStatus.REJECTED]: 'Tu solicitud de proveedor fue rechazada',
  [UserStatus.DISABLED]: 'Tu cuenta está deshabilitada',
};

type StoredUser = User & { _id: Types.ObjectId };

/** Datos del usuario que sí pueden salir en una respuesta (sin hash ni documento). */
export type PublicUser = {
  id: string;
  email: string;
  nombre: string;
  rol: Role;
  status: UserStatus;
};

/** Perfil propio: lo público más la tienda asignada, si existe. */
export type Profile = PublicUser & { storeId?: string };

export type LoginResult = {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: PublicUser;
};

export const toPublicUser = (user: StoredUser): PublicUser => ({
  id: user._id.toString(),
  email: user.email,
  nombre: user.nombre,
  rol: user.rol,
  status: user.status,
});

/** Error de clave duplicada de Mongo (índice único). */
const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 11000;

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Registro público. PRODUCTOR queda `ACTIVE`; PROVEEDOR queda
   * `PENDING_APPROVAL` hasta que un ADMIN lo apruebe. Un email repetido
   * (incluido uno `REJECTED`) responde 409.
   */
  async register(dto: RegisterDto): Promise<PublicUser> {
    this.passwords.assertPolicy(dto.password, dto.email);
    const passwordHash = await this.passwords.hash(dto.password);

    const status =
      dto.rol === Role.PROVEEDOR
        ? UserStatus.PENDING_APPROVAL
        : UserStatus.ACTIVE;

    let created: UserDocument;
    try {
      created = await this.userModel.create({
        email: dto.email,
        passwordHash,
        nombre: dto.nombre,
        documento: dto.documento,
        rol: dto.rol,
        status,
        consent: { acceptedAt: new Date(), version: CONSENT_VERSION },
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictException('El email ya está registrado');
      }
      throw error;
    }

    const user = toPublicUser(created);
    this.events.emit(AuthEvents.UserRegistered, {
      userId: user.id,
      email: user.email,
      rol: user.rol,
      status: user.status,
    } satisfies UserRegisteredEvent);
    return user;
  }

  /**
   * Login. Email inexistente, contraseña errónea y cuenta bloqueada responden
   * igual (401). El estado de la cuenta (403) solo se revela con la contraseña
   * correcta. 5 fallos seguidos bloquean la cuenta 15 minutos.
   */
  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.userModel
      .findOne({ email: dto.email })
      .select('+passwordHash')
      .lean<StoredUser>();

    // Con usuario inexistente se compara contra un hash falso para igualar tiempos.
    const passwordOk = await this.passwords.compare(
      dto.password,
      user?.passwordHash,
    );
    if (!user) throw this.invalidCredentials();

    const now = Date.now();
    const lockActive = !!user.lockedUntil && user.lockedUntil.getTime() > now;
    // Se compara igualmente aunque esté bloqueada, y no cuenta como intento.
    if (lockActive) throw this.invalidCredentials();

    if (!passwordOk) {
      await this.registerFailedAttempt(user, now);
      throw this.invalidCredentials();
    }

    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await this.userModel.updateOne(
        { _id: user._id },
        { $set: { failedLoginAttempts: 0 }, $unset: { lockedUntil: 1 } },
      );
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException(STATUS_MESSAGES[user.status]);
    }

    return this.openSession(user);
  }

  /** Abre una sesión nueva y devuelve los tokens. */
  async openSession(user: StoredUser): Promise<LoginResult> {
    const userId = user._id.toString();
    const { token: refreshToken, familyId } =
      await this.tokens.startSession(userId);
    const accessToken = await this.tokens.signAccessToken({
      userId,
      rol: user.rol,
      sessionId: familyId,
      storeId: user.storeId?.toString(),
    });
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user: toPublicUser(user),
    };
  }

  /**
   * Canjea el refresh token por un par nuevo (rotación). Si el usuario ya no
   * existe o no está `ACTIVE`, la sesión se cierra y responde 401.
   */
  async refresh(dto: RefreshDto): Promise<LoginResult> {
    const rotated = await this.tokens.rotate(dto.refreshToken);

    const user = await this.userModel
      .findById(rotated.userId)
      .lean<StoredUser>();
    if (!user || user.status !== UserStatus.ACTIVE) {
      await this.tokens.revokeFamily(rotated.familyId);
      throw new UnauthorizedException('Refresh token inválido');
    }

    const accessToken = await this.tokens.signAccessToken({
      userId: rotated.userId,
      rol: user.rol,
      sessionId: rotated.familyId,
      storeId: user.storeId?.toString(),
    });
    return {
      accessToken,
      refreshToken: rotated.token,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user: toPublicUser(user),
    };
  }

  /** Cierra la sesión actual: su refresh token (y toda su familia) deja de servir. */
  async logout(sessionId: string): Promise<void> {
    await this.tokens.revokeFamily(sessionId);
  }

  /** Perfil del usuario autenticado, leído de la base (no del token). */
  async getProfile(userId: string): Promise<Profile> {
    const user = await this.userModel.findById(userId).lean<StoredUser>();
    if (!user) throw new UnauthorizedException('No autenticado');
    return {
      ...toPublicUser(user),
      ...(user.storeId && { storeId: user.storeId.toString() }),
    };
  }

  /**
   * Cambia la contraseña: exige la actual (401 si falla), aplica la política a
   * la nueva y cierra todas las sesiones del usuario.
   */
  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.userModel
      .findById(userId)
      .select('+passwordHash')
      .lean<StoredUser>();

    const currentOk = await this.passwords.compare(
      dto.currentPassword,
      user?.passwordHash,
    );
    if (!user || !currentOk) {
      throw new UnauthorizedException('Contraseña actual incorrecta');
    }

    this.passwords.assertPolicy(dto.newPassword, user.email);
    const passwordHash = await this.passwords.hash(dto.newPassword);
    await this.userModel.updateOne(
      { _id: user._id },
      { $set: { passwordHash, passwordChangedAt: new Date() } },
    );
    await this.tokens.revokeAllForUser(userId);
  }

  private async registerFailedAttempt(
    user: StoredUser,
    now: number,
  ): Promise<void> {
    const lockExpired = !!user.lockedUntil && user.lockedUntil.getTime() <= now;
    if (lockExpired) {
      // El bloqueo ya venció: el conteo empieza de nuevo con este fallo.
      await this.userModel.updateOne(
        { _id: user._id },
        { $set: { failedLoginAttempts: 1 }, $unset: { lockedUntil: 1 } },
      );
      return;
    }

    const updated = await this.userModel.findOneAndUpdate(
      { _id: user._id },
      { $inc: { failedLoginAttempts: 1 } },
      { returnDocument: 'after' },
    );
    if (updated && updated.failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
      await this.userModel.updateOne(
        { _id: user._id },
        { $set: { lockedUntil: new Date(now + LOCK_DURATION_MS) } },
      );
    }
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException(INVALID_CREDENTIALS);
  }
}
