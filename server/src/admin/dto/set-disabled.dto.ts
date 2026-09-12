import { IsBoolean } from 'class-validator';

/**
 * Takes the desired state rather than a flip, the same shape as
 * SessionsController's roster-active toggle — so two taps in flight cannot
 * cancel each other out.
 */
export class SetDisabledDto {
  @IsBoolean()
  disabled!: boolean;
}
