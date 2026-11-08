import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { type Model } from 'mongoose';
import { Role } from '../../../../../../libs/common/src/security/roles.js';
import { CatalogEvents, type StoreCreatedEvent } from '../../catalog/index.js';
import { User, type UserDocument } from '../schemas/user.schema.js';

/**
 * Guarda el `storeId` del PROVEEDOR cuando `catalog` crea su tienda. `catalog`
 * no escribe en `users`: avisa con `store.created` y `auth` actualiza lo suyo.
 * El `storeId` llega al access token al renovar el refresh token.
 */
@Injectable()
export class StoreAssignmentService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  @OnEvent(CatalogEvents.StoreCreated)
  async handleStoreCreated({
    storeId,
    ownerId,
  }: StoreCreatedEvent): Promise<void> {
    await this.userModel.updateOne(
      { _id: ownerId, rol: Role.PROVEEDOR, storeId: { $exists: false } },
      { $set: { storeId } },
    );
  }
}
