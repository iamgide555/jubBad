import { IsIn } from 'class-validator';
import { SESSION_MODES, type SessionMode } from '../session-mode.js';

export class SetModeDto {
  @IsIn(SESSION_MODES)
  mode!: SessionMode;
}
