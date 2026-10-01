import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min, ValidateNested } from 'class-validator';
import { ShuttleChoiceDto } from './shuttle-choice.dto.js';

/**
 * Manual confirm. `shuttle` is required on a session that opted into shuttle
 * tools and refused on one that did not; the service decides, since the
 * session's snapshot — not the payload — says which kind it is.
 */
export class ConfirmPairingDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedRevision?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ShuttleChoiceDto)
  shuttle?: ShuttleChoiceDto;
}
