import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The player who owns the group's receiving account. The decorators are
 * required, not decorative: the global pipe's whitelist strips an undecorated
 * field. null passes IsOptional and means "no collector"; whether a string id
 * is a real, linked player of this group is assertCollectorEligible's call
 * (409 COLLECTOR_INVALID), so the cap here only bounds the request size.
 */
export class SetPayCollectorDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  playerId?: string | null;
}
