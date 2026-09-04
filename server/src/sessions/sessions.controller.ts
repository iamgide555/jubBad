import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { SessionsService } from './sessions.service.js';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Post()
  create(@Body() dto: CreateSessionDto) {
    return this.sessionsService.createSession(dto);
  }

  @Get(':code')
  findOne(@Param('code') code: string) {
    return this.sessionsService.getSession(code);
  }
}
