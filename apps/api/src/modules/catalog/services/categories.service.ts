import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model } from 'mongoose';
import type {
  CreateCategoryDto,
  UpdateCategoryDto,
} from '../dto/category.dto.js';
import { isDuplicateKeyError } from '../policies/duplicate-key.policy.js';
import { Category, type CategoryDocument } from '../schemas/category.schema.js';

export type CategoryView = { id: string; nombre: string; activa: boolean };

const toCategoryView = (category: {
  _id: { toString(): string };
  nombre: string;
  activa: boolean;
}): CategoryView => ({
  id: category._id.toString(),
  nombre: category.nombre,
  activa: category.activa,
});

const NOMBRE_REPETIDO = 'Ya existe una categoría con ese nombre';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectModel(Category.name)
    private readonly categoryModel: Model<CategoryDocument>,
  ) {}

  /** Crea una categoría. Un nombre repetido (índice único) responde 409. */
  async create(dto: CreateCategoryDto): Promise<CategoryView> {
    try {
      return toCategoryView(await this.categoryModel.create(dto));
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictException(NOMBRE_REPETIDO);
      }
      throw error;
    }
  }

  /** Lista todas las categorías, desactivadas incluidas, ordenadas por nombre. */
  async listAdmin(): Promise<CategoryView[]> {
    const categories = await this.categoryModel
      .find()
      .sort({ nombre: 1 })
      .lean();
    return categories.map(toCategoryView);
  }

  /** Cambia `nombre` y/o `activa`. 404 si no existe, 409 si el nombre ya está en uso. */
  async update(id: string, dto: UpdateCategoryDto): Promise<CategoryView> {
    let updated;
    try {
      updated = await this.categoryModel
        .findByIdAndUpdate(id, { $set: dto }, { new: true })
        .lean();
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictException(NOMBRE_REPETIDO);
      }
      throw error;
    }
    if (!updated) throw new NotFoundException('Categoría no encontrada');
    return toCategoryView(updated);
  }
}
