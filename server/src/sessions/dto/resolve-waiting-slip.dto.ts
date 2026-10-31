import { IsArray, IsNotEmpty, IsOptional, IsString, IsInt, Min, Max } from 'class-validator';

export class ResolveWaitingSlipDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  reviewedAmountSatang?: number;

  /** The players this slip pays for. An empty list is the service's COVERS_REQUIRED refusal, not a shape error. */
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  coversPlayerIds!: string[];

  /** Who sent the slip, to remember their LINE account for future nights; absent or null links nobody. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  senderPlayerId?: string | null;
}
