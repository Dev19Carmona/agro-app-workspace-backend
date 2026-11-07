import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

/** Tamaño máximo del body (JSON y formularios). */
export const BODY_LIMIT = '100kb';

/** Convierte `CORS_ORIGINS` (lista separada por comas) en orígenes limpios. */
export function parseCorsOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export interface SecurityOptions {
  /** Lista blanca de orígenes CORS. Vacía = sin orígenes cruzados. */
  corsOrigins: string[];
}

/**
 * Endurecimiento HTTP de una app Express: `helmet`, CORS con lista blanca,
 * sin `X-Powered-By` y con límite de tamaño del body.
 */
export function applySecurity(
  app: NestExpressApplication,
  { corsOrigins }: SecurityOptions,
): void {
  app.disable('x-powered-by');
  app.use(helmet());
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true });

  // Sin lista blanca no se habilita CORS: el navegador bloquea lo cruzado.
  if (corsOrigins.length > 0) {
    app.enableCors({
      origin: corsOrigins,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    });
  }
}
