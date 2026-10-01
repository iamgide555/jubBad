import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import { GroupsService } from './groups.service.js';
import { Public } from '../auth/public.decorator.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { UpdateGroupDto } from './dto/update-group.dto.js';
import { ParseRosterDto } from './dto/parse-roster.dto.js';
import { UpdatePlayerDto } from './dto/update-player.dto.js';
import { SetPlayerLevelDto } from './dto/set-player-level.dto.js';
import { SetPlayerRuleDto, SetPlayerRuleKindDto } from './dto/set-player-rule.dto.js';
import { SetShuttleToolsDto } from './dto/set-shuttle-tools.dto.js';

@Controller('groups')
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  /**
   * The admin's home page. Deliberately NOT public: it is the only endpoint in
   * the app that can enumerate groups — everything else requires you to already
   * know a code — so it is the one route that would turn a leaked URL into a
   * map of everything.
   *
   * Scoped to the caller's own groups (all of them, for an admin) — the
   * OwnershipGuard cannot filter a list, since a list isn't addressed by a
   * single :code, so the filter lives here instead.
   */
  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.groupsService.listGroups(req.user);
  }

  /** Public: the venue display shows the group's name. */
  @Public()
  @Get(':code')
  findOne(@Param('code') code: string) {
    return this.groupsService.findOne(code);
  }

  @Put(':code')
  update(@Param('code') code: string, @Body() dto: UpdateGroupDto) {
    return this.groupsService.update(code, dto);
  }

  /**
   * Advanced host tools switch (numbered shuttles, early checkout). Owner-only
   * like every non-@Public group route — the OwnershipGuard 404s a mismatch.
   * Read here rather than off the public group GET so it is never exposed.
   */
  @Get(':code/shuttle-tools')
  getShuttleTools(@Param('code') code: string) {
    return this.groupsService.getShuttleTools(code);
  }

  @Post(':code/shuttle-tools')
  setShuttleTools(@Param('code') code: string, @Body() dto: SetShuttleToolsDto) {
    return this.groupsService.setShuttleTools(code, dto.enabled);
  }

  /** Whether pairing history spans earlier sessions; snapshotted per session. */
  @Get(':code/cross-session-history')
  getCrossSessionHistory(@Param('code') code: string) {
    return this.groupsService.getCrossSessionHistory(code);
  }

  @Post(':code/cross-session-history')
  setCrossSessionHistory(@Param('code') code: string, @Body() dto: SetShuttleToolsDto) {
    return this.groupsService.setCrossSessionHistory(code, dto.enabled);
  }

  /** Public: the display resolves player ids to names client-side. */
  @Public()
  @Get(':code/players')
  listPlayers(@Param('code') code: string) {
    return this.groupsService.listPlayers(code);
  }

  @Get(':code/sessions')
  listSessions(@Param('code') code: string) {
    return this.groupsService.listSessions(code);
  }

  /**
   * Gated (unlike the @Public() listPlayers above): full contact info, so
   * this must never be reachable without the host's session cookie.
   */
  @Get(':code/players/manage')
  listPlayersManage(@Param('code') code: string) {
    return this.groupsService.listPlayersManage(code);
  }

  @Put(':code/players/:playerId')
  updatePlayer(
    @Param('code') code: string,
    @Param('playerId') playerId: string,
    @Body() dto: UpdatePlayerDto
  ) {
    return this.groupsService.updatePlayer(code, playerId, dto);
  }

  /**
   * A one-field save for the roster page's inline level chip. Gated, like
   * `updatePlayer` — a level is host-only, never reachable without the
   * host's session cookie.
   */
  @Put(':code/players/:playerId/level')
  updatePlayerLevel(
    @Param('code') code: string,
    @Param('playerId') playerId: string,
    @Body() dto: SetPlayerLevelDto
  ) {
    return this.groupsService.updatePlayerLevel(code, playerId, dto.level ?? null);
  }

  /** Pair rules (host-feedback C). Gated: rules are host-only, never public. */
  @Get(':code/rules')
  listRules(@Param('code') code: string) {
    return this.groupsService.listRules(code);
  }

  @Post(':code/rules')
  createRule(@Param('code') code: string, @Body() dto: SetPlayerRuleDto) {
    return this.groupsService.createRule(code, dto);
  }

  @Put(':code/rules/:ruleId')
  setRuleKind(@Param('code') code: string, @Param('ruleId') ruleId: string, @Body() dto: SetPlayerRuleKindDto) {
    return this.groupsService.setRuleKind(code, ruleId, dto.kind);
  }

  @Delete(':code/rules/:ruleId')
  deleteRule(@Param('code') code: string, @Param('ruleId') ruleId: string) {
    return this.groupsService.deleteRule(code, ruleId);
  }

  /** Public: a player's own stat card, read-only. */
  @Public()
  @Get(':code/players/:playerId/stats')
  playerStats(@Param('code') code: string, @Param('playerId') playerId: string) {
    return this.groupsService.playerStats(code, playerId);
  }

  /**
   * Gated. Every player, session and match in one response — a GET, which makes
   * it easy to overlook when thinking of auth as protecting writes.
   */
  @Get(':code/export')
  export(@Param('code') code: string) {
    return this.groupsService.exportGroup(code);
  }

  @Delete(':code')
  remove(@Param('code') code: string) {
    return this.groupsService.deleteGroup(code);
  }

  /**
   * Gated, and this is also what stops anonymous group creation: the service
   * upserts whatever code is in the URL, so before auth any caller could mint
   * groups at will — and now that there is a group list, straight into it.
   *
   * This is also the create-or-own point: OwnershipGuard lets a request
   * through whenever the code names no existing group, because that is
   * exactly how a new group gets claimed — see GroupsService.parse, which
   * does the actual claiming atomically against a concurrent claim of the
   * same fresh code.
   */
  @Post(':code/parse')
  parse(@Param('code') code: string, @Body() dto: ParseRosterDto, @Req() req: AuthenticatedRequest) {
    return this.groupsService.parse(code, dto, req.user);
  }
}
