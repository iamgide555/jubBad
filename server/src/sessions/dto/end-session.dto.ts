import { IsBoolean, IsOptional } from 'class-validator';

export class EndSessionDto {
  /** Post the night's summary card to the group's LINE group once the session has ended. */
  @IsOptional()
  @IsBoolean()
  sendLineSummary?: boolean;
}
