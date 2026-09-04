import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { FinishPairingDto } from './dto/finish-pairing.dto.js';
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

  @Post(':code/courts/:n/propose')
  propose(@Param('code') code: string, @Param('n', ParseIntPipe) courtNumber: number) {
    return this.sessionsService.propose(code, courtNumber);
  }

  @Post(':code/pairings/:id/confirm')
  confirmPairing(@Param('id') id: string) {
    return this.sessionsService.confirmPairing(id);
  }

  @Post(':code/pairings/:id/finish')
  finishPairing(@Param('id') id: string, @Body() dto: FinishPairingDto) {
    return this.sessionsService.finishPairing(id, dto);
  }

  @Post(':code/end')
  endSession(@Param('code') code: string) {
    return this.sessionsService.endSession(code);
  }
}
