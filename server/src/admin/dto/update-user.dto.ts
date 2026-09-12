import { IsEmail, IsIn, IsOptional, MaxLength } from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @IsIn(['admin', 'host'])
  role?: 'admin' | 'host';
}
