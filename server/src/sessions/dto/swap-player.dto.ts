import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class SwapPlayerDto {
  /** The player leaving the court. */
  @IsString()
  playerId!: string;

  /**
   * Who comes on. Omitted means "pick for me", which follows normal rotation.
   * Naming someone is the manual choice: they may be waiting, or already on
   * another pending court, in which case the two trade places.
   */
  @IsOptional()
  @IsString()
  withPlayerId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  expectedRevision?: number;
}
