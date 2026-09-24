import { IsString, MinLength } from 'class-validator';

export class ParseRosterDto {
  @IsString()
  @MinLength(1)
  groupName!: string;

  /** Empty is allowed: the manual "add players yourself" flow (no LINE
   *  message to paste) reuses this endpoint to claim/create the group, just
   *  with nothing to parse — see GroupEntry.startManual. */
  @IsString()
  rawText!: string;
}
