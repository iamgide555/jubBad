import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import { AdminService } from './admin.service.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { SetDisabledDto } from './dto/set-disabled.dto.js';
import { DeleteUserDto } from './dto/delete-user.dto.js';
import { ReassignOwnerDto } from './dto/reassign-owner.dto.js';

/**
 * Every route here requires role: 'admin'. Not enforced by a guard on this
 * controller — the global OwnershipGuard already refuses any non-admin on
 * every /admin path (an admin bypasses it at the top; anyone else is
 * refused as soon as the path is recognised as this prefix). See
 * OwnershipGuard and admin.spec.ts, which is what actually proves it.
 */
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('users')
  listUsers() {
    return this.adminService.listUsers();
  }

  @Post('users')
  createUser(@Body() dto: CreateUserDto) {
    return this.adminService.createUser(dto);
  }

  @Put('users/:id')
  updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.adminService.updateUser(id, dto);
  }

  @Post('users/:id/disabled')
  setDisabled(@Param('id') id: string, @Body() dto: SetDisabledDto) {
    return this.adminService.setDisabled(id, dto.disabled);
  }

  @Delete('users/:id')
  deleteUser(@Param('id') id: string, @Body() dto: DeleteUserDto) {
    return this.adminService.deleteUser(id, dto.groups);
  }

  @Post('users/:id/reset')
  async resetUserPassword(@Param('id') id: string): Promise<{ token: string }> {
    const token = await this.adminService.resetUserPassword(id);
    return { token };
  }

  @Get('groups')
  listGroups() {
    return this.adminService.listGroups();
  }

  @Post('groups/:code/owner')
  reassignGroupOwner(@Param('code') code: string, @Body() dto: ReassignOwnerDto) {
    return this.adminService.reassignGroupOwner(code, dto.toUserId);
  }

  @Get('reset-requests')
  listResetRequests() {
    return this.adminService.listResetRequests();
  }

  @Post('reset-requests/:id/handle')
  async handleResetRequest(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest
  ): Promise<{ handled: true }> {
    await this.adminService.handleResetRequest(id, req.user.id);
    return { handled: true };
  }
}
