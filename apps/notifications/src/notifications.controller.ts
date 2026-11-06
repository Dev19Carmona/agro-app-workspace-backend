import { ApiTags } from '@nestjs/swagger';
import { Controller, Get } from '@nestjs/common';
import { NotificationsService } from './notifications.service.js';

@ApiTags('notifications')
@Controller()
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  getHello(): string {
    return this.notificationsService.getHello();
  }
}
