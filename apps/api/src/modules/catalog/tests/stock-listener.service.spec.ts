import { StockListenerService } from '../services/stock-listener.service.js';

const metadata = (metodo: string) =>
  Reflect.getMetadata(
    'EVENT_LISTENER_METADATA',
    Object.getOwnPropertyDescriptor(StockListenerService.prototype, metodo)
      ?.value,
  );

const sobre = <T extends string, P>(type: T, payload: P) => ({
  eventId: 'e1',
  type,
  occurredAt: '2026-11-07T00:00:00.000Z',
  correlationId: 'o1',
  payload,
});

describe('StockListenerService', () => {
  const reserve = vi.fn();
  const confirm = vi.fn();
  const release = vi.fn();
  const service = new StockListenerService({
    reserve,
    confirm,
    release,
  } as never);

  it.each([
    ['handleOrderCreated', 'order.created'],
    ['handleOrderConfirmed', 'order.confirmed'],
    ['handleOrderCancelled', 'order.cancelled'],
  ])('%s escucha %s', (metodo, evento) => {
    expect(metadata(metodo)?.[0]?.event).toBe(evento);
  });

  it('order.created delega en StockService.reserve', async () => {
    const evento = sobre('order.created', { orderId: 'o1', items: [] });

    await service.handleOrderCreated(evento);

    expect(reserve).toHaveBeenCalledWith(evento);
  });

  it('order.confirmed delega en StockService.confirm', async () => {
    const evento = sobre('order.confirmed', { orderId: 'o1' });

    await service.handleOrderConfirmed(evento);

    expect(confirm).toHaveBeenCalledWith(evento);
  });

  it('order.cancelled delega en StockService.release', async () => {
    const evento = sobre('order.cancelled', { orderId: 'o1' });

    await service.handleOrderCancelled(evento);

    expect(release).toHaveBeenCalledWith(evento);
  });
});
