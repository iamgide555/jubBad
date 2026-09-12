import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(512)
  password!: string;

  @IsOptional()
  @IsIn(['admin', 'host'])
  role?: 'admin' | 'host';
}
