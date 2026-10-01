import { IsBoolean } from 'class-validator';

/**
 * A required boolean for a group-level switch (shuttle tools, cross-session
 * history). Strict on purpose: "yes" or 1 must be a 400, not a coerced value.
 */
export class SetShuttleToolsDto {
  @IsBoolean()
  enabled!: boolean;
}
