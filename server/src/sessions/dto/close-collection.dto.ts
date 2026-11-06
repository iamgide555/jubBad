import { Equals, IsBoolean, IsOptional } from 'class-validator';

export class CloseCollectionDto {
  @IsBoolean()
  @Equals(true)
  confirmDeleteImages!: true;

  /** The close dialog's tick for posting the awards card; missing means send it, so an older client still does. */
  @IsOptional()
  @IsBoolean()
  sendCard?: boolean;
}
