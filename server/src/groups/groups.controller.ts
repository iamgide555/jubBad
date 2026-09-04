import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { GroupsService } from './groups.service.js';
import { UpdateGroupDto } from './dto/update-group.dto.js';

@Controller('groups')
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  @Get(':code')
  findOne(@Param('code') code: string) {
    return this.groupsService.findOne(code);
  }

  @Put(':code')
  update(@Param('code') code: string, @Body() dto: UpdateGroupDto) {
    return this.groupsService.update(code, dto);
  }

  @Get(':code/players')
  listPlayers(@Param('code') code: string) {
    return this.groupsService.listPlayers(code);
  }
}
