import { IsNotEmpty, IsString, ValidateIf } from 'class-validator';

export class SetPlayerLinkDto {
  @IsString()
  @IsNotEmpty()
  playerId!: string;

  /** The LINE account to point the player at, or an explicit null to remove the player's link. */
  @ValidateIf((o: SetPlayerLinkDto) => o.lineUserId !== null)
  @IsString()
  @IsNotEmpty()
  lineUserId!: string | null;
}
