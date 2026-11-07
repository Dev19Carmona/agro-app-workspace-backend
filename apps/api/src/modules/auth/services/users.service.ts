import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { type QueryFilter, type Model, Types } from 'mongoose';
import { Role } from '../../../../../libs/common/src/security/roles.js';
import {
  AuthEvents,
  type ProviderApprovedEvent,
  type ProviderRejectedEvent,
} from './auth.events.js';
import type { ListUsersQuery } from './dto/users-admin.dto.js';
import { User, type UserDocument, UserStatus } from './schemas/user.schema.js';
import { TokenService } from './token.service.js';

type StoredUser = User & { _id: Types.ObjectId };

/** Vista de un usuario para el ADMIN: nunca incluye `passwordHash`. */
export type AdminUserView = {
  id: string;
  email: string;
  nombre: string;
  documento: string;
  rol: Role;
  status: UserStatus;
  storeId?: string;
  rejectionReason?: string;
  reviewedBy?: string;
  reviewedAt?: Date;
  createdAt: Date;
};

export type UserPage = {
  data: AdminUserView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export const toAdminView = (u: StoredUser): AdminUserView => ({
  id: u._id.toString(),
  email: u.email,
  nombre: u.nombre,
  documento: u.documento,
  rol: u.rol,
  status: u.status,
  ...(u.storeId && { storeId: u.storeId.toString() }),
  ...(u.rejectionReason && { rejectionReason: u.rejectionReason }),
  ...(u.reviewedBy && { reviewedBy: u.reviewedBy.toString() }),
  ...(u.reviewedAt && { reviewedAt: u.reviewedAt }),
  createdAt: u.createdAt,
});

/** Estados desde los que se puede cambiar el rol: los demás pertenecen al flujo de aprobación. */
const ROLE_CHANGE_STATUSES = [UserStatus.ACTIVE, UserStatus.DISABLED];

/** Consulta y revisión de usuarios por un ADMIN. */
@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly tokens: TokenService,
    private readonly events: EventEmitter2,
  ) {}

  async list(query: ListUsersQuery): Promise<UserPage> {
    const filter: QueryFilter<UserDocument> = {
      ...(query.rol && { rol: query.rol }),
      ...(query.status && { status: query.status }),
    };
    const [users, total] = await Promise.all([
      this.userModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean<StoredUser[]>(),
      this.userModel.countDocuments(filter),
    ]);
    return {
      data: users.map(toAdminView),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async findOne(id: string): Promise<AdminUserView> {
    const user = await this.userModel.findById(id).lean<StoredUser>();
    if (!user) throw this.notFound();
    return toAdminView(user);
  }

  /** Aprueba la solicitud de un PROVEEDOR pendiente y emite `provider.approved`. */
  async approve(id: string, adminId: string): Promise<AdminUserView> {
    const user = await this.transition(
      id,
      { rol: Role.PROVEEDOR, status: UserStatus.PENDING_APPROVAL },
      {
        $set: {
          status: UserStatus.ACTIVE,
          reviewedBy: new Types.ObjectId(adminId),
          reviewedAt: new Date(),
        },
        $unset: { rejectionReason: 1 },
      },
      'Solo se puede aprobar a un PROVEEDOR pendiente de aprobación',
    );
    this.events.emit(AuthEvents.ProviderApproved, {
      userId: id,
      email: user.email,
      reviewedBy: adminId,
    } satisfies ProviderApprovedEvent);
    return toAdminView(user);
  }

  /** Rechaza la solicitud de un PROVEEDOR pendiente y emite `provider.rejected`. */
  async reject(
    id: string,
    adminId: string,
    reason?: string,
  ): Promise<AdminUserView> {
    const user = await this.transition(
      id,
      { rol: Role.PROVEEDOR, status: UserStatus.PENDING_APPROVAL },
      {
        $set: {
          status: UserStatus.REJECTED,
          reviewedBy: new Types.ObjectId(adminId),
          reviewedAt: new Date(),
          ...(reason && { rejectionReason: reason }),
        },
      },
      'Solo se puede rechazar a un PROVEEDOR pendiente de aprobación',
    );
    this.events.emit(AuthEvents.ProviderRejected, {
      userId: id,
      email: user.email,
      reviewedBy: adminId,
      ...(reason && { reason }),
    } satisfies ProviderRejectedEvent);
    return toAdminView(user);
  }

  /** `ACTIVE` → `DISABLED` y cierra todas sus sesiones. Un ADMIN no puede deshabilitarse. */
  async disable(id: string, adminId: string): Promise<AdminUserView> {
    this.assertNotSelf(id, adminId);
    const user = await this.transition(
      id,
      { status: UserStatus.ACTIVE },
      { $set: { status: UserStatus.DISABLED } },
      'Solo se puede deshabilitar a un usuario activo',
    );
    await this.tokens.revokeAllForUser(id);
    return toAdminView(user);
  }

  /** `DISABLED` → `ACTIVE`. */
  async enable(id: string): Promise<AdminUserView> {
    const user = await this.transition(
      id,
      { status: UserStatus.DISABLED },
      { $set: { status: UserStatus.ACTIVE } },
      'Solo se puede habilitar a un usuario deshabilitado',
    );
    return toAdminView(user);
  }

  /**
   * Cambia el rol y cierra todas sus sesiones, para que el token nuevo lleve
   * el rol nuevo. Un ADMIN no puede cambiarse el rol a sí mismo. Solo aplica a
   * usuarios `ACTIVE` o `DISABLED`; los pendientes y rechazados siguen el flujo
   * de aprobación. Si el rol ya es ese, no hace nada.
   */
  async changeRole(
    id: string,
    adminId: string,
    rol: Role,
  ): Promise<AdminUserView> {
    this.assertNotSelf(id, adminId);
    const current = await this.userModel.findById(id).lean<StoredUser>();
    if (!current) throw this.notFound();
    if (current.rol === rol) return toAdminView(current);

    const user = await this.transition(
      id,
      { status: { $in: ROLE_CHANGE_STATUSES } },
      { $set: { rol } },
      'Solo se puede cambiar el rol de un usuario activo o deshabilitado',
    );
    await this.tokens.revokeAllForUser(id);
    return toAdminView(user);
  }

  /**
   * Actualiza de forma atómica solo si el usuario cumple las condiciones. Si
   * no coincide distingue 404 (no existe) de 409 (estado incompatible).
   */
  private async transition(
    id: string,
    conditions: QueryFilter<UserDocument>,
    update: Record<string, unknown>,
    conflictMessage: string,
  ): Promise<StoredUser> {
    const updated = await this.userModel
      .findOneAndUpdate({ _id: id, ...conditions }, update, {
        returnDocument: 'after',
      })
      .lean<StoredUser>();
    if (updated) return updated;

    const exists = await this.userModel.exists({ _id: id });
    throw exists ? new ConflictException(conflictMessage) : this.notFound();
  }

  private assertNotSelf(id: string, adminId: string): void {
    if (id === adminId) {
      throw new ForbiddenException(
        'Un ADMIN no puede modificar su propia cuenta',
      );
    }
  }

  private notFound(): NotFoundException {
    return new NotFoundException('Usuario no encontrado');
  }
}
