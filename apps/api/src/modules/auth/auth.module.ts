import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import type { ApiEnv } from '../../../../../libs/common/src/config/env.schema.js';
import { AuthController } from './controllers/auth.controller.js';
import { AuthService } from './services/auth.service.js';
import { PasswordService } from './services/password.service.js';
import {
  RefreshToken,
  RefreshTokenSchema,
} from './schemas/refresh-token.schema.js';
import { User, UserSchema } from './schemas/user.schema.js';
import { TokenService } from './services/token.service.js';
import { UsersAdminController } from './controllers/users-admin.controller.js';
import { UsersService } from './services/users.service.js';
import { StoreAssignmentService } from './services/store-assignment.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: RefreshToken.name, schema: RefreshTokenSchema },
    ]),
    // Solo `auth` firma: usa la clave privada. El resto del sistema verifica con la pública.
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<ApiEnv, true>) => ({
        privateKey: config.get('JWT_PRIVATE_KEY', { infer: true }),
      }),
    }),
  ],
  controllers: [AuthController, UsersAdminController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    UsersService,
    StoreAssignmentService,
  ],
})
export class AuthModule {}
