import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export interface SwaggerOptions {
  title: string;
  description: string;
  /** Ruta donde se sirve la UI de Swagger. Por defecto `docs`. */
  path?: string;
}

/**
 * Configura Swagger (OpenAPI) para una app Nest.
 * UI en `/<path>` y JSON en `/<path>-json`.
 */
export function setupSwagger(
  app: INestApplication,
  { title, description, path = 'docs' }: SwaggerOptions,
): void {
  const config = new DocumentBuilder()
    .setTitle(title)
    .setDescription(description)
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(path, app, document, {
    swaggerOptions: { persistAuthorization: true },
  });
}
