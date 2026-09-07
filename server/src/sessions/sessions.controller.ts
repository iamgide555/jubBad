import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { FinishPairingDto } from './dto/finish-pairing.dto.js';
import { SetModeDto } from './dto/set-mode.dto.js';
import { SetRosterActiveDto } from './dto/set-roster-active.dto.js';
import { SwapPlayerDto } from './dto/swap-player.dto.js';
import { Public } from '../auth/public.decorator.js';
import { SessionsService } from './sessions.service.js';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Post()
  create(@Body() dto: CreateSessionDto) {
    return this.sessionsService.createSession(dto);
  }

  /**
   * Public: this is what the venue display polls. The only read the wall TV
   * needs from this controller, and it exposes nothing a player in the hall
   * cannot already see by looking at the courts.
   */
  @Public()
  @Get(':code')
  findOne(@Param('code') code: string) {
    return this.sessionsService.getSession(code);
  }

  @Post(':code/courts/fill')
  fill(@Param('code') code: string) {
    return this.sessionsService.fillIdleCourts(code);
  }

  @Post(':code/courts/:n/propose')
  propose(@Param('code') code: string, @Param('n', ParseIntPipe) courtNumber: number) {
    return this.sessionsService.propose(code, courtNumber);
  }

  @Post(':code/courts/:n/undo')
  undo(@Param('code') code: string, @Param('n', ParseIntPipe) courtNumber: number) {
    return this.sessionsService.undoLastOnCourt(code, courtNumber);
  }

  @Post(':code/pairings/:id/confirm')
  confirmPairing(@Param('code') code: string, @Param('id') id: string) {
    return this.sessionsService.confirmPairing(code, id);
  }

  @Post(':code/pairings/:id/finish')
  finishPairing(
    @Param('code') code: string,
    @Param('id') id: string,
    @Body() dto: FinishPairingDto
  ) {
    return this.sessionsService.finishPairing(code, id, dto);
  }

  @Post(':code/pairings/:id/swap')
  swapPlayer(
    @Param('code') code: string,
    @Param('id') id: string,
    @Body() dto: SwapPlayerDto
  ) {
    return this.sessionsService.swapPlayer(code, id, dto);
  }

  @Post(':code/roster/:playerId/active')
  setRosterActive(
    @Param('code') code: string,
    @Param('playerId') playerId: string,
    @Body() dto: SetRosterActiveDto
  ) {
    return this.sessionsService.setRosterActive(code, playerId, dto);
  }

  @Post(':code/mode')
  setMode(@Param('code') code: string, @Body() dto: SetModeDto) {
    return this.sessionsService.setMode(code, dto);
  }

  @Post(':code/end')
  endSession(@Param('code') code: string) {
    return this.sessionsService.endSession(code);
  }

  @Get(':code/stats')
  getStats(@Param('code') code: string, @Query('scope') scope?: string) {
    return this.sessionsService.getStats(code, scope === 'all' ? 'all' : 'session');
  }
}
