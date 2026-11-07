import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import {
  CurrentUser,
  Public,
} from '../../../../../../libs/common/src/security/decorators.js';
import type { AuthenticatedUser } from '../../../../../../libs/common/src/security/roles.js';
import {
  AuthService,
  type LoginResult,
  type Profile,
  type PublicUser,
} from '../services/auth.service.js';
import { type LoginDto, loginSchema } from '../dto/login.dto.js';
import { type RegisterDto, registerSchema } from '../dto/register.dto.js';
import {
  type ChangePasswordDto,
  changePasswordSchema,
  type RefreshDto,
  refreshSchema,
} from '../dto/session.dto.js';

/** 5 peticiones por minuto por IP en los endpoints de credenciales. */
const CREDENTIALS_THROTTLE = { default: { limit: 5, ttl: 60_000 } };
/** 10 por minuto en refresh: un cliente legítimo renueva pocas veces. */
const REFRESH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

const jsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema) as Record<string, unknown>;

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle(CREDENTIALS_THROTTLE)
  @Post('register')
  @ApiOperation({
    summary:
      'Registro público. PRODUCTOR queda activo; PROVEEDOR queda pendiente de aprobación.',
  })
  @ApiBody({ schema: jsonSchema(registerSchema) })
  register(
    @Body({ schema: registerSchema }) dto: RegisterDto,
  ): Promise<PublicUser> {
    return this.authService.register(dto);
  }

  @Public()
  @Throttle(CREDENTIALS_THROTTLE)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Inicia sesión y devuelve access y refresh token.' })
  @ApiBody({ schema: jsonSchema(loginSchema) })
  login(@Body({ schema: loginSchema }) dto: LoginDto): Promise<LoginResult> {
    return this.authService.login(dto);
  }

  @Public()
  @Throttle(REFRESH_THROTTLE)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Rota el refresh token. Reutilizar uno ya usado cierra toda la sesión.',
  })
  @ApiBody({ schema: jsonSchema(refreshSchema) })
  refresh(
    @Body({ schema: refreshSchema }) dto: RefreshDto,
  ): Promise<LoginResult> {
    return this.authService.refresh(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cierra la sesión actual.' })
  logout(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.authService.logout(user.sessionId);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Perfil del usuario autenticado.' })
  me(@CurrentUser() user: AuthenticatedUser): Promise<Profile> {
    return this.authService.getProfile(user.id);
  }

  @Throttle(CREDENTIALS_THROTTLE)
  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Cambia la contraseña y cierra todas las sesiones. Hay que iniciar sesión de nuevo.',
  })
  @ApiBody({ schema: jsonSchema(changePasswordSchema) })
  changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: changePasswordSchema }) dto: ChangePasswordDto,
  ): Promise<void> {
    return this.authService.changePassword(user.id, dto);
  }
}
