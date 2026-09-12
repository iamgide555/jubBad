import { IsObject } from 'class-validator';

export interface GroupDisposition {
  action: 'reassign' | 'delete' | 'unassign';
  toUserId?: string;
}

/**
 * Keyed by group code, so its shape cannot be pinned down with class-
 * validator's per-property decorators — AdminService#deleteUser validates
 * each entry itself, including the harder property (every owned group must
 * be named, and only those) that a shape-only DTO could never check anyway.
 */
export class DeleteUserDto {
  @IsObject()
  groups!: Record<string, GroupDisposition>;
}
