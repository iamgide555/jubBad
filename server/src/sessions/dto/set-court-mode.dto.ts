import { IsIn } from 'class-validator';
import { SESSION_MODES, type SessionMode } from '../session-mode.js';

export class SetCourtModeDto {
  @IsIn(SESSION_MODES)
  mode!: SessionMode;
}
