import { Role } from '../../../../../../libs/common/src/security/roles.js';
import { actorFor } from '../policies/actor.policy.js';

const USER = '64b7f0c2a1b2c3d4e5f60718';
const STORE = '64b7f0c2a1b2c3d4e5f60719';

describe('actorFor', () => {
  it('PRODUCTOR: solo userId, aunque el token traiga storeId', () => {
    expect(actorFor({ id: USER, rol: Role.PRODUCTOR })).toEqual({
      userId: USER,
    });
    expect(actorFor({ id: USER, rol: Role.PRODUCTOR, storeId: STORE })).toEqual(
      { userId: USER },
    );
  });

  it('PROVEEDOR con storeId en el token: userId y storeId', () => {
    expect(actorFor({ id: USER, rol: Role.PROVEEDOR, storeId: STORE })).toEqual(
      { userId: USER, storeId: STORE },
    );
  });

  it('PROVEEDOR sin storeId en el token: solo userId', () => {
    const actor = actorFor({ id: USER, rol: Role.PROVEEDOR });
    expect(actor).toEqual({ userId: USER });
    expect(actor).not.toHaveProperty('storeId');
  });
});
