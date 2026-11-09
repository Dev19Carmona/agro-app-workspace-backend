import { actorFilter } from './actor-filter.policy.js';

const USER = '64b7f0c2a1b2c3d4e5f60718';
const STORE = '64b7f0c2a1b2c3d4e5f60719';

describe('actorFilter', () => {
  it('sin storeId solo incluye los avisos USER del usuario', () => {
    expect(actorFilter({ userId: USER })).toEqual({
      $or: [{ destinatarioTipo: 'USER', destinatarioId: USER }],
    });
  });

  it('con storeId suma los avisos STORE de esa tienda', () => {
    expect(actorFilter({ userId: USER, storeId: STORE })).toEqual({
      $or: [
        { destinatarioTipo: 'USER', destinatarioId: USER },
        { destinatarioTipo: 'STORE', destinatarioId: STORE },
      ],
    });
  });
});
