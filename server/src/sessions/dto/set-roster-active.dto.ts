import { IsBoolean } from 'class-validator';

export class SetRosterActiveDto {
  /**
   * The desired state, not a flip. Two taps in flight would toggle twice and
   * land back where they started; an explicit target is idempotent.
   */
  @IsBoolean()
  active!: boolean;
}
