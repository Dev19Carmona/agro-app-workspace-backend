import type { Role } from '../../../../../libs/common/src/security/roles.js';
import type { UserStatus } from './schemas/user.schema.js';

/** Nombres de los eventos de dominio de `auth` (en memoria, vía `@nestjs/event-emitter`). */
export const AuthEvents = {
  UserRegistered: 'user.registered',
  ProviderApproved: 'provider.approved',
  ProviderRejected: 'provider.rejected',
} as const;

export type UserRegisteredEvent = {
  userId: string;
  email: string;
  rol: Role;
  status: UserStatus;
};

export type ProviderApprovedEvent = {
  userId: string;
  email: string;
  reviewedBy: string;
};

export type ProviderRejectedEvent = {
  userId: string;
  email: string;
  reviewedBy: string;
  reason?: string;
};
