import { Type } from 'class-transformer';
import { IsBoolean, IsDefined, IsInt, IsOptional, Min, ValidateNested } from 'class-validator';
import { ShuttleChoiceDto } from './shuttle-choice.dto.js';

/** Live switch on an active advanced game. The revision guards against a late winner tap. */
export class SwitchShuttleDto {
  // ValidateNested alone passes a missing object, which then crashed the service.
  @IsDefined()
  @ValidateNested()
  @Type(() => ShuttleChoiceDto)
  choice!: ShuttleChoiceDto;

  @IsInt()
  @Min(0)
  expectedRevision!: number;

  /** Retire the shuttle being switched away from, in the same action. */
  @IsOptional()
  @IsBoolean()
  retirePrevious?: boolean;
}
