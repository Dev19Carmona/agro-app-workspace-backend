import type { DestinatarioTipo } from '../schemas/notification.schema.js';

/** Quién consulta: el usuario y, si es PROVEEDOR con tienda, su `storeId`. */
export type Actor = { userId: string; storeId?: string };

export type ActorFilter = {
  $or: { destinatarioTipo: DestinatarioTipo; destinatarioId: string }[];
};

/**
 * Filtro de Mongo con los avisos que el actor puede ver. Listar, contar, `read` y
 * `read-all` parten de él, así ninguna operación puede salirse del actor.
 */
export function actorFilter({ userId, storeId }: Actor): ActorFilter {
  return {
    $or: [
      { destinatarioTipo: 'USER', destinatarioId: userId },
      ...(storeId
        ? [{ destinatarioTipo: 'STORE' as const, destinatarioId: storeId }]
        : []),
    ],
  };
}
