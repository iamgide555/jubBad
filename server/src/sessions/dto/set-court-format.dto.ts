import { IsIn } from 'class-validator';

export class SetCourtFormatDto {
  @IsIn(['doubles', 'singles'])
  format!: 'doubles' | 'singles';
}
