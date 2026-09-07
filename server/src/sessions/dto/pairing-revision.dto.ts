import { IsInt, IsOptional, Min } from 'class-validator';

export class PairingRevisionDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedRevision?: number;
}
