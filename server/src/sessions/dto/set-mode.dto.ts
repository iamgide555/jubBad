import { IsIn } from 'class-validator';

export class SetModeDto {
  @IsIn(['variety', 'balanced'])
  mode!: 'variety' | 'balanced';
}
