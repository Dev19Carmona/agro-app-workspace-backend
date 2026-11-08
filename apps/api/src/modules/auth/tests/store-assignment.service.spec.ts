import { Types } from 'mongoose';
import { Role } from '../../../../../../libs/common/src/security/roles.js';
import { StoreAssignmentService } from '../services/store-assignment.service.js';

describe('StoreAssignmentService', () => {
  const updateOne = vi.fn();
  let service: StoreAssignmentService;
  const evento = {
    storeId: new Types.ObjectId().toString(),
    ownerId: new Types.ObjectId().toString(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    service = new StoreAssignmentService({ updateOne } as never);
  });

  it('asigna storeId solo a un PROVEEDOR que aún no lo tiene', async () => {
    await service.handleStoreCreated(evento);

    expect(updateOne).toHaveBeenCalledWith(
      {
        _id: evento.ownerId,
        rol: Role.PROVEEDOR,
        storeId: { $exists: false },
      },
      { $set: { storeId: evento.storeId } },
    );
  });

  it('el filtro no sobrescribe un storeId existente ni toca otros roles', async () => {
    await service.handleStoreCreated(evento);

    const [filtro] = updateOne.mock.calls[0];
    expect(filtro.storeId).toEqual({ $exists: false });
    expect(filtro.rol).toBe(Role.PROVEEDOR);
    expect(filtro.rol).not.toBe(Role.PRODUCTOR);
    expect(filtro.rol).not.toBe(Role.ADMIN);
  });

  it('escucha el evento store.created', () => {
    const meta = Reflect.getMetadata(
      'EVENT_LISTENER_METADATA',
      Object.getOwnPropertyDescriptor(
        StoreAssignmentService.prototype,
        'handleStoreCreated',
      )?.value,
    );
    expect(meta?.[0]?.event).toBe('store.created');
  });
});
