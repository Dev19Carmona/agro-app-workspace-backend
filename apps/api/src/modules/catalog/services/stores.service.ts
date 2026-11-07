import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, type QueryFilter } from 'mongoose';
import type { StoresQuery } from '../dto/catalog-query.dto.js';
import type { CreateStoreDto, UpdateStoreDto } from '../dto/store.dto.js';
import {
  CatalogEvents,
  type StoreCreatedEvent,
} from '../events/catalog.events.js';
import { isDuplicateKeyError } from '../policies/duplicate-key.policy.js';
import { type Page, toPage } from '../policies/pagination.policy.js';
import { Store, type StoreDocument } from '../schemas/store.schema.js';

export type StoreView = {
  id: string;
  nombre: string;
  nit: string;
  ownerId: string;
  municipio: string;
  activa: boolean;
  createdAt: Date;
};

type StoreLike = Pick<
  Store,
  'nombre' | 'nit' | 'ownerId' | 'municipio' | 'activa' | 'createdAt'
> & { _id: { toString(): string } };

export const toStoreView = (store: StoreLike): StoreView => ({
  id: store._id.toString(),
  nombre: store.nombre,
  nit: store.nit,
  ownerId: store.ownerId.toString(),
  municipio: store.municipio,
  activa: store.activa,
  createdAt: store.createdAt,
});

@Injectable()
export class StoresService {
  constructor(
    @InjectModel(Store.name) private readonly storeModel: Model<StoreDocument>,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Crea la tienda del PROVEEDOR. `ownerId` sale del token. La segunda tienda
   * del mismo dueño (índice único) responde 409. Emite `store.created`.
   */
  async create(ownerId: string, dto: CreateStoreDto): Promise<StoreView> {
    let created: StoreDocument;
    try {
      created = await this.storeModel.create({ ...dto, ownerId });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictException('El proveedor ya tiene una tienda');
      }
      throw error;
    }

    const view = toStoreView(created);
    this.events.emit(CatalogEvents.StoreCreated, {
      storeId: view.id,
      ownerId: view.ownerId,
    } satisfies StoreCreatedEvent);
    return view;
  }

  /** ADMIN: lista todas las tiendas, desactivadas incluidas. */
  async listAdmin(query: StoresQuery): Promise<Page<StoreView>> {
    const filter: QueryFilter<StoreDocument> = {
      ...(query.municipio && { municipio: query.municipio }),
    };
    const [stores, total] = await Promise.all([
      this.storeModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      this.storeModel.countDocuments(filter),
    ]);
    return toPage(stores.map(toStoreView), total, query.page, query.limit);
  }

  /** ADMIN: detalle de una tienda, activa o no. */
  async findOneAdmin(id: string): Promise<StoreView> {
    const store = await this.storeModel.findById(id).lean();
    if (!store) throw this.notFound();
    return toStoreView(store);
  }

  /** ADMIN: solo `nombre`, `nit` y `municipio`. */
  async updateAdmin(id: string, dto: UpdateStoreDto): Promise<StoreView> {
    const store = await this.storeModel
      .findByIdAndUpdate(id, { $set: dto }, { new: true })
      .lean();
    if (!store) throw this.notFound();
    return toStoreView(store);
  }

  /** ADMIN: `activa = false`. Idempotente; no borra la tienda. */
  async deactivate(id: string): Promise<StoreView> {
    const store = await this.storeModel
      .findByIdAndUpdate(id, { $set: { activa: false } }, { new: true })
      .lean();
    if (!store) throw this.notFound();
    return toStoreView(store);
  }

  private notFound(): NotFoundException {
    return new NotFoundException('Tienda no encontrada');
  }

  /** Tienda del PROVEEDOR, buscada por `ownerId`; 404 si aún no tiene. */
  async getMine(ownerId: string): Promise<StoreView> {
    const store = await this.storeModel.findOne({ ownerId }).lean();
    if (!store) throw new NotFoundException('Aún no tienes una tienda');
    return toStoreView(store);
  }
}
