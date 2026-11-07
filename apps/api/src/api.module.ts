import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import type { Env } from '../../../libs/common/src/config/env.schema.js';
import { validateEnv } from '../../../libs/common/src/config/env.schema.js';
import { HealthModule } from '../../../libs/common/src/health/health.module.js';
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
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        uri: config.get('MONGODB_URI', { infer: true }),
        dbName: 'mini-croper',
      }),
    }),
    HealthModule,
    AuthModule,
    CatalogModule,
    OrderModule,
    PaymentsModule,
  ],
})
export class ApiModule {}
