import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The group's default payment account. The decorators are required, not
 * decorative: the global pipe's whitelist silently strips an undecorated field.
 * The caps here only bound the request size; the real limits (bank 40, name 80,
 * number 6-20) and the all-or-none rule live in validatePayAccount, so every
 * rejection answers the same PAY_ACCOUNT_INVALID.
 */
export class SetPayAccountDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  bank?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  number?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}
