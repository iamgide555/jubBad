import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * The host's shuttle choice for a game: open a new numbered shuttle, or take
 * an existing one. Which fields go with which kind is checked by
 * `parseShuttleChoice` (shuttle-tracking.ts) so the rule has one home.
 */
export class ShuttleChoiceDto {
  @IsIn(['new', 'existing'])
  kind!: 'new' | 'existing';

  @IsOptional()
  @IsString()
  @MinLength(1)
  shuttleId?: string;
}
