import { IsNotEmpty, IsString } from 'class-validator';

export class LinkLineAccountDto {
  @IsString()
  @IsNotEmpty()
  playerId!: string;
}
