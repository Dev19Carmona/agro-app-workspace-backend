import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import type { ApiEnv } from '../../../libs/common/src/config/env.schema.js';
import { validateApiEnv } from '../../../libs/common/src/config/env.schema.js';
import { HealthModule } from '../../../libs/common/src/health/health.module.js';
import { SecurityModule } from '../../../libs/common/src/security/security.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { OrderModule } from './modules/order/order.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';

/**
 * Monolito modular: núcleo de Mini-Croper (auth, catálogo, pedidos y pagos).
 * Cada dominio es un módulo con fronteras claras para poder extraerlo
 * a un servicio aparte si la carga lo justifica.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateApiEnv }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<ApiEnv, true>) => ({
        uri: config.get('MONGODB_URI', { infer: true }),
        dbName: 'mini-croper',
      }),
    }),
    SecurityModule,
    HealthModule,
    AuthModule,
    CatalogModule,
    OrderModule,
    PaymentsModule,
  ],
})
export class ApiModule {}
