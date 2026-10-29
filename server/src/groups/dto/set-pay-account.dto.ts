import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The group's default payment account. The decorators are required, not
 * decorative: the global pipe's whitelist silently strips an undecorated field.
 * The caps here only bound the request size. A non-string value or a string over
 * the cap is rejected by the pipe with a generic 400 that carries no code. The
 * real limits (bank 40, name 80, number 6-20) and the all-or-none rule live in
 * validatePayAccount, whose { ok: false } is what answers PAY_ACCOUNT_INVALID.
 * null passes IsOptional and reads as blank there, so an all-null body clears.
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
