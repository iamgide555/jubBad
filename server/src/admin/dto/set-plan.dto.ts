import { IsIn, Matches, ValidateIf } from 'class-validator';
import { PLANS, type Plan } from '../../plans/plan.js';

export class SetPlanDto {
  @IsIn(PLANS)
  plan!: Plan;

  /** `YYYY-MM-DD` (end of that day, Bangkok), or null for a plan that never lapses. */
  @ValidateIf((_o, v) => v !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  renewsAt!: string | null;
}
