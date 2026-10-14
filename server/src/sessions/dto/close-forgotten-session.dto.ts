import { IsString, Matches } from 'class-validator';

export class CloseForgottenSessionDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  snapshotHash!: string;
}
