import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class SwapPlayerDto {
  @IsString()
  playerId!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  expectedRevision?: number;
}
