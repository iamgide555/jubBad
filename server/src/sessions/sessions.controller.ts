import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { AddWalkInDto } from './dto/add-walk-in.dto.js';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { FinishPairingDto } from './dto/finish-pairing.dto.js';
import { ConfirmPairingDto } from './dto/confirm-pairing.dto.js';
import { CorrectShuttleUseDto } from './dto/correct-shuttle-use.dto.js';
import { CorrectResultDto } from './dto/correct-result.dto.js';
import { SetShuttleUsableDto } from './dto/set-shuttle-usable.dto.js';
import { SwitchShuttleDto } from './dto/switch-shuttle.dto.js';
import { PairingRevisionDto } from './dto/pairing-revision.dto.js';
import { SetCourtCountDto } from './dto/set-court-count.dto.js';
import { SetCourtFormatDto } from './dto/set-court-format.dto.js';
import { SetCourtLabelDto } from './dto/set-court-label.dto.js';
import { SetCourtModeDto } from './dto/set-court-mode.dto.js';
import { SetModeDto } from './dto/set-mode.dto.js';
import { SetRosterActiveDto } from './dto/set-roster-active.dto.js';
import { SetRosterWalkInDto } from './dto/set-roster-walk-in.dto.js';
import { LineupDto, MoveLineupDto } from './dto/lineup.dto.js';
import { SetSeatDto } from './dto/set-seat.dto.js';
import { SetShuttleDetailsDto } from './dto/set-shuttle-details.dto.js';
import { SwapPlayerDto } from './dto/swap-player.dto.js';
import { TogglePairRuleDto } from './dto/toggle-pair-rule.dto.js';
import { Public } from '../auth/public.decorator.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { SessionsService } from './sessions.service.js';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  /**
   * The group is named in the body (`dto.groupCode`), not the URL, so
   * OwnershipGuard cannot check this route by path alone — it explicitly lets
   * `POST /sessions` through and defers to the check inside
   * SessionsService.createSession instead.
   */
  @Post()
  create(@Body() dto: CreateSessionDto, @Req() req: AuthenticatedRequest) {
    return this.sessionsService.createSession(dto, req.user);
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

  /**
   * Per-court, not a whole-array write: a stale tab overwriting every
   * court's format at once would silently revert a neighbour's toggle since
   * the last time that tab loaded. This shape's read-modify-write happens
   * server-side, inside the session lock, so a neighbouring court's change
   * can never be lost.
   */
  @Post(':code/courts/:n/format')
  setCourtFormat(
    @Param('code') code: string,
    @Param('n', ParseIntPipe) courtNumber: number,
    @Body() dto: SetCourtFormatDto
  ) {
    return this.sessionsService.setCourtFormat(code, courtNumber, dto);
  }

  /**
   * Per-court sticky mode, custom sessions only in effect (see
   * effectiveCourtMode) — settable in any court state, unlike the format
   * toggle, since it never changes a live pairing's shape.
   */
  @Post(':code/courts/:n/mode')
  setCourtMode(
    @Param('code') code: string,
    @Param('n', ParseIntPipe) courtNumber: number,
    @Body() dto: SetCourtModeDto
  ) {
    return this.sessionsService.setCourtMode(code, courtNumber, dto);
  }

  /**
   * Per-court display name, like format/mode a single-slot server-side
   * write so two devices renaming different courts never lose each other's
   * change. Allowed in every court and session state, including ended.
   */
  @Post(':code/courts/:n/label')
  setCourtLabel(
    @Param('code') code: string,
    @Param('n', ParseIntPipe) courtNumber: number,
    @Body() dto: SetCourtLabelDto
  ) {
    return this.sessionsService.setCourtLabel(code, courtNumber, dto);
  }

  @Post(':code/pairings/:id/confirm')
  confirmPairing(
    @Param('code') code: string,
    @Param('id') id: string,
    @Body() dto: ConfirmPairingDto
  ) {
    return this.sessionsService.confirmPairing(code, id, dto.expectedRevision, dto.shuttle);
  }

  /**
   * Shuttle writes (host feedback D): owner-only like every non-public route,
   * serialized by the session lock and guarded by `Pairing.revision`.
   */
  @Post(':code/pairings/:id/shuttles/switch')
  switchShuttle(@Param('code') code: string, @Param('id') id: string, @Body() dto: SwitchShuttleDto) {
    return this.sessionsService.switchShuttle(code, id, dto);
  }

  @Post(':code/pairings/:id/shuttles/correct')
  correctShuttleUse(@Param('code') code: string, @Param('id') id: string, @Body() dto: CorrectShuttleUseDto) {
    return this.sessionsService.correctShuttleUse(code, id, dto);
  }

  /** Owner-only: identities plus each finished game's editable set and revision. */
  @Get(':code/shuttles')
  getShuttleInventory(@Param('code') code: string) {
    return this.sessionsService.getShuttleInventory(code);
  }

  @Post(':code/shuttles/:shuttleId/usable')
  setShuttleUsable(
    @Param('code') code: string,
    @Param('shuttleId') shuttleId: string,
    @Body() dto: SetShuttleUsableDto
  ) {
    return this.sessionsService.setShuttleUsable(code, shuttleId, dto.usable);
  }

  @Post(':code/shuttles/:shuttleId/void')
  voidShuttle(@Param('code') code: string, @Param('shuttleId') shuttleId: string) {
    return this.sessionsService.voidShuttle(code, shuttleId);
  }

  @Post(':code/pairings/:id/finish')
  finishPairing(
    @Param('code') code: string,
    @Param('id') id: string,
    @Body() dto: FinishPairingDto
  ) {
    return this.sessionsService.finishPairing(code, id, dto);
  }

  /**
   * Owner-only: fix a finished game's winner/score, also after the session
   * ended. Ratings are replayed on read, so a correction flows through.
   */
  @Post(':code/pairings/:id/result/correct')
  correctResult(@Param('code') code: string, @Param('id') id: string, @Body() dto: CorrectResultDto) {
    return this.sessionsService.correctResult(code, id, dto);
  }

  /** Owner-only: each finished game's revision, which a result correction must send. */
  @Get(':code/results')
  getResultRevisions(@Param('code') code: string) {
    return this.sessionsService.getResultRevisions(code);
  }

  @Post(':code/pairings/:id/swap')
  swapPlayer(
    @Param('code') code: string,
    @Param('id') id: string,
    @Body() dto: SwapPlayerDto
  ) {
    return this.sessionsService.swapPlayer(code, id, dto);
  }

  /**
   * Custom mode's seat-by-seat editor: names a player into one seat, or
   * (omitting `playerId`) vacates it. Not mode-gated — see the comment on
   * `SessionsService.setSeat`.
   */
  @Post(':code/pairings/:id/seats')
  setSeat(
    @Param('code') code: string,
    @Param('id') id: string,
    @Body() dto: SetSeatDto
  ) {
    return this.sessionsService.setSeat(code, id, dto);
  }

  /** Host-set lineups waiting for a free court. Read back through `GET :code` (`lineupQueue`). */
  @Post(':code/queue')
  addLineup(@Param('code') code: string, @Body() dto: LineupDto) {
    return this.sessionsService.addLineup(code, dto);
  }

  @Post(':code/queue/:id')
  replaceLineup(@Param('code') code: string, @Param('id') id: string, @Body() dto: LineupDto) {
    return this.sessionsService.replaceLineup(code, id, dto);
  }

  @Post(':code/queue/:id/move')
  moveLineup(@Param('code') code: string, @Param('id') id: string, @Body() dto: MoveLineupDto) {
    return this.sessionsService.moveLineup(code, id, dto);
  }

  @Delete(':code/queue')
  clearLineups(@Param('code') code: string) {
    return this.sessionsService.clearLineups(code);
  }

  @Delete(':code/queue/:id')
  removeLineup(@Param('code') code: string, @Param('id') id: string) {
    return this.sessionsService.removeLineup(code, id);
  }

  @Post(':code/pairings/:id/autopair')
  autoPair(
    @Param('code') code: string,
    @Param('id') id: string,
    @Body() dto: PairingRevisionDto
  ) {
    return this.sessionsService.autoPair(code, id, dto.expectedRevision);
  }

  @Post(':code/roster')
  addWalkIn(@Param('code') code: string, @Body() dto: AddWalkInDto) {
    return this.sessionsService.addWalkIn(code, dto);
  }

  @Post(':code/roster/:playerId/active')
  setRosterActive(
    @Param('code') code: string,
    @Param('playerId') playerId: string,
    @Body() dto: SetRosterActiveDto
  ) {
    return this.sessionsService.setRosterActive(code, playerId, dto);
  }

  @Post(':code/roster/:playerId/walk-in')
  setRosterWalkIn(
    @Param('code') code: string,
    @Param('playerId') playerId: string,
    @Body() dto: SetRosterWalkInDto
  ) {
    return this.sessionsService.setRosterWalkIn(code, playerId, dto);
  }

  @Post(':code/roster/deprioritize-waiting')
  deprioritizeWaiting(@Param('code') code: string) {
    return this.sessionsService.deprioritizeWaiting(code);
  }

  @Post(':code/court-count')
  setCourtCount(@Param('code') code: string, @Body() dto: SetCourtCountDto) {
    return this.sessionsService.setCourtCount(code, dto);
  }

  @Post(':code/mode')
  setMode(@Param('code') code: string, @Body() dto: SetModeDto) {
    return this.sessionsService.setMode(code, dto);
  }

  /**
   * Gated: pair rules are host-only, read separately from the public poll
   * exactly like levels below.
   */
  @Get(':code/rules')
  getSessionRules(@Param('code') code: string) {
    return this.sessionsService.getSessionRules(code);
  }

  /** Switches one group rule off (or back on) for this session only. */
  @Post(':code/rules/:ruleId/toggle')
  toggleSessionRule(
    @Param('code') code: string,
    @Param('ruleId') ruleId: string,
    @Body() dto: TogglePairRuleDto
  ) {
    return this.sessionsService.toggleSessionRule(code, ruleId, dto.enabled);
  }

  /**
   * Gated, unlike `findOne` above: a level is host-only (C1, decision Q6),
   * so it is read separately rather than folded into the public session poll.
   */
  @Get(':code/levels')
  getLevels(@Param('code') code: string) {
    return this.sessionsService.getLevels(code);
  }

  @Post(':code/end')
  endSession(@Param('code') code: string) {
    return this.sessionsService.endSession(code);
  }

  /**
   * Host-only metadata, deliberately allowed after the session has ended —
   * the host counts shuttles at the end, so this is the one narrow exception
   * to the ended-session guard every other mutation on this controller
   * enforces. See SessionsService.setShuttleDetails.
   */
  @Post(':code/shuttle-details')
  setShuttleDetails(@Param('code') code: string, @Body() dto: SetShuttleDetailsDto) {
    return this.sessionsService.setShuttleDetails(code, dto);
  }

  @Get(':code/stats')
  getStats(@Param('code') code: string, @Query('scope') scope?: string) {
    return this.sessionsService.getStats(code, scope === 'all' ? 'all' : 'session');
  }

  /**
   * Host-only (C1a): the dashboard's toggle player panel — every roster
   * player's level, resting state, tonight's played/won/lost, and their
   * rating as a difference from the level's seed. See
   * SessionsService.getPlayerPanel's doc comment for the shape.
   */
  @Get(':code/players')
  getPlayerPanel(@Param('code') code: string) {
    return this.sessionsService.getPlayerPanel(code);
  }

  /**
   * Public: the host shares this link (copy-link button on the dashboard)
   * rather than it being discoverable anywhere else — knowledge of the
   * session code is what gates access, the same trust model as the player
   * stat card and the venue display.
   */
  @Public()
  @Get(':code/summary')
  getSummary(@Param('code') code: string) {
    return this.sessionsService.getSummary(code);
  }
}
