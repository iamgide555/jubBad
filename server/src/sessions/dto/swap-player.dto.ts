import { IsString } from 'class-validator';

export class SwapPlayerDto {
  @IsString()
  playerId!: string;
}
