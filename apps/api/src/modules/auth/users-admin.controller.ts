import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  Roles,
} from '../../../../../libs/common/src/security/decorators.js';
import {
  type AuthenticatedUser,
  Role,
} from '../../../../../libs/common/src/security/roles.js';
import {
  type ChangeRoleDto,
  changeRoleSchema,
  type ListUsersQuery,
  listUsersQuerySchema,
  objectIdSchema,
  type RejectDto,
  rejectSchema,
} from './dto/users-admin.dto.js';
import {
  type AdminUserView,
  type UserPage,
  UsersService,
} from './users.service.js';

/** Gestión de usuarios: solo ADMIN. */
@ApiTags('auth')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('auth/users')
export class UsersAdminController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista usuarios con paginación y filtros por rol y status.',
  })
  list(
    @Query({ schema: listUsersQuerySchema }) query: ListUsersQuery,
  ): Promise<UserPage> {
    return this.usersService.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un usuario.' })
  findOne(
    @Param('id', { schema: objectIdSchema }) id: string,
  ): Promise<AdminUserView> {
    return this.usersService.findOne(id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aprueba la solicitud de un PROVEEDOR.' })
  approve(
    @Param('id', { schema: objectIdSchema }) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminUserView> {
    return this.usersService.approve(id, admin.id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rechaza la solicitud de un PROVEEDOR (motivo opcional).',
  })
  reject(
    @Param('id', { schema: objectIdSchema }) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body({ schema: rejectSchema }) dto: RejectDto,
  ): Promise<AdminUserView> {
    return this.usersService.reject(id, admin.id, dto?.reason);
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deshabilita un usuario activo y cierra sus sesiones.',
  })
  disable(
    @Param('id', { schema: objectIdSchema }) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminUserView> {
    return this.usersService.disable(id, admin.id);
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Habilita un usuario deshabilitado.' })
  enable(
    @Param('id', { schema: objectIdSchema }) id: string,
  ): Promise<AdminUserView> {
    return this.usersService.enable(id);
  }

  @Patch(':id/role')
  @ApiOperation({
    summary: 'Cambia el rol de un usuario y cierra sus sesiones.',
  })
  changeRole(
    @Param('id', { schema: objectIdSchema }) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body({ schema: changeRoleSchema }) dto: ChangeRoleDto,
  ): Promise<AdminUserView> {
    return this.usersService.changeRole(id, admin.id, dto.rol);
  }
}
