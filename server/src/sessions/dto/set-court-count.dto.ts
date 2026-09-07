import { IsInt, Max, Min } from 'class-validator';

export class SetCourtCountDto {
  /**
   * Upper bound is a sanity limit, not a venue rule: a hall with more than 20
   * courts is not the kind of session this app runs, and an unbounded value
   * would let a typo generate thousands of court panels.
   */
  @IsInt()
  @Min(1)
  @Max(20)
  courtCount!: number;
}
