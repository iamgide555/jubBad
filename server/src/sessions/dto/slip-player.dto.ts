import { IsNotEmpty, IsString } from 'class-validator';

/** A body naming one player: a pay-page claim, or the host's tick and untick. */
export class SlipPlayerDto {
  @IsString()
  @IsNotEmpty()
  playerId!: string;
}
