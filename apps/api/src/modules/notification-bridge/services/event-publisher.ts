import type { WireEvent } from '../../../../../../libs/common/src/messaging/domain-event.schema.js';

/** Token de inyección: cambiar de broker es cambiar el provider. */
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

export interface EventPublisher {
  isConnected(): boolean;
  /** Resuelve cuando el broker confirma el mensaje; rechaza si no lo confirma. */
  publish(event: WireEvent): Promise<void>;
}
