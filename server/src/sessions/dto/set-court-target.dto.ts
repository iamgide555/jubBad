import { IsIn } from 'class-validator';
import { COURT_TARGETS, type CourtTarget } from '../court-targets.js';

export class SetCourtTargetDto {
  @IsIn(COURT_TARGETS)
  target!: CourtTarget;
}
