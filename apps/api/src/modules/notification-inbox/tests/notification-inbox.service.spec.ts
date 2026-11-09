import { Role } from '../../../../../../libs/common/src/security/roles.js';
import { NotificationInboxService } from '../services/notification-inbox.service.js';

const USER = '64b7f0c2a1b2c3d4e5f60718';
const STORE = '64b7f0c2a1b2c3d4e5f60719';
const ID = '64b7f0c2a1b2c3d4e5f60700';

const productor = { id: USER, rol: Role.PRODUCTOR, sessionId: 's1' };
const proveedor = {
  id: USER,
  rol: Role.PROVEEDOR,
  sessionId: 's1',
  storeId: STORE,
};
const proveedorSinTienda = { id: USER, rol: Role.PROVEEDOR, sessionId: 's1' };

describe('NotificationInboxService', () => {
  const reader = {
    list: vi.fn(),
    unreadCount: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
  };
  let service: NotificationInboxService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new NotificationInboxService(reader);
  });

  it('list: PRODUCTOR sin storeId', async () => {
    reader.list.mockResolvedValue({ data: [], nextCursor: null });

    await service.list(productor, { limit: 20 });

    expect(reader.list).toHaveBeenCalledWith(
      { userId: USER },
      { limit: 20, cursor: undefined },
    );
  });

  it('list: PROVEEDOR con storeId y cursor', async () => {
    reader.list.mockResolvedValue({ data: [], nextCursor: null });

    await service.list(proveedor, { limit: 5, cursor: ID });

    expect(reader.list).toHaveBeenCalledWith(
      { userId: USER, storeId: STORE },
      { limit: 5, cursor: ID },
    );
  });

  it('unreadCount: PROVEEDOR sin storeId solo cuenta los USER', async () => {
    reader.unreadCount.mockResolvedValue({ count: 1 });

    expect(await service.unreadCount(proveedorSinTienda)).toEqual({
      count: 1,
    });
    expect(reader.unreadCount).toHaveBeenCalledWith({ userId: USER });
  });

  it('markRead: delega con el actor del token y el id', async () => {
    reader.markRead.mockResolvedValue({ id: ID });

    await service.markRead(proveedor, ID);

    expect(reader.markRead).toHaveBeenCalledWith(
      { userId: USER, storeId: STORE },
      ID,
    );
  });

  it('markAllRead: delega con el actor del token', async () => {
    reader.markAllRead.mockResolvedValue({ updated: 2 });

    expect(await service.markAllRead(productor)).toEqual({ updated: 2 });
    expect(reader.markAllRead).toHaveBeenCalledWith({ userId: USER });
  });

  it('el actor nunca viene de la petición: la query no puede traer userId ni storeId', async () => {
    reader.list.mockResolvedValue({ data: [], nextCursor: null });
    const query = {
      limit: 20,
      userId: 'otro',
      storeId: 'otra',
    } as never;

    await service.list(productor, query);

    expect(reader.list).toHaveBeenCalledWith(
      { userId: USER },
      { limit: 20, cursor: undefined },
    );
  });
});
