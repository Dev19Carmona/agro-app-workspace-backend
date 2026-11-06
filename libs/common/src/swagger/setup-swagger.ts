import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export interface SwaggerOptions {
  title: string;
  description: string;
  /** Ruta donde se sirve la UI de Swagger. Por defecto `docs`. */
  path?: string;
  /** Tags con descripción (uno por módulo) para agrupar la UI. */
  tags?: { name: string; description: string }[];
}

/**
 * Configura Swagger (OpenAPI) para una app Nest.
 * UI en `/<path>` y JSON en `/<path>-json`.
 */
export function setupSwagger(
  app: INestApplication,
  { title, description, path = 'docs', tags = [] }: SwaggerOptions,
): void {
  const builder = new DocumentBuilder()
    .setTitle(title)
    .setDescription(description)
    .setVersion('1.0')
    .addBearerAuth();
  for (const tag of tags) {
    builder.addTag(tag.name, tag.description);
  }
  const config = builder.build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(path, app, document, {
    swaggerOptions: { persistAuthorization: true },
  });
}
