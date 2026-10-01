import { IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

/**
 * Exactly one of `playerId` (an existing group player) or `name` (create a
 * new one) — class-validator has no built-in XOR, so SessionsService.addWalkIn
 * enforces that and throws ROSTER_ADD_INVALID_INPUT if neither or both arrive.
 */
export class AddWalkInDto {
  @IsOptional()
  @IsString()
  playerId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  /** Only meaningful with `name` — a new player can be given a level up front. */
  @IsOptional()
  @IsString()
  level?: string;

  /** Required with a `level`: the ladder revision the host saw, so a stale tab cannot reapply a cleared label. */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedLadderRevision?: number;
}
