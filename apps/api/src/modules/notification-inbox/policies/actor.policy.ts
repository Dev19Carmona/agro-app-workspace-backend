import {
  type AuthenticatedUser,
  Role,
} from '../../../../../../libs/common/src/security/roles.js';
import type { InboxActor } from '../services/notifications-reader.js';

/**
 * Actor que viaja a `notifications`. Sale siempre del token: `userId` del claim `sub` y
 * `storeId` solo si el rol es PROVEEDOR y el token lo trae. El cliente no lo puede pedir.
 */
export function actorFor(
  user: Pick<AuthenticatedUser, 'id' | 'rol' | 'storeId'>,
): InboxActor {
  return user.rol === Role.PROVEEDOR && user.storeId
    ? { userId: user.id, storeId: user.storeId }
    : { userId: user.id };
}
