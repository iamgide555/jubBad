import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn } from 'class-validator';

/**
 * A host-set lineup for a future match. A seat is a player id or `null` (open,
 * for the engine to fill). Seat contents are validated in the service, where
 * the roster and rules are known; this only pins the shape.
 */
export class LineupDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  teamA!: (string | null)[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  teamB!: (string | null)[];
}

export class MoveLineupDto {
  @IsIn(['up', 'down'])
  direction!: 'up' | 'down';
}
