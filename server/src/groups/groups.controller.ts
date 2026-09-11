import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import { GroupsService } from './groups.service.js';
import { Public } from '../auth/public.decorator.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { UpdateGroupDto } from './dto/update-group.dto.js';
import { ParseRosterDto } from './dto/parse-roster.dto.js';

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
