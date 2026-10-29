import { IsUUID } from 'class-validator';

export class SendPaymentCardDto {
  /**
   * Made by the client once per tap of Send. A network retry of that tap reuses it, so LINE drops the repeat
   * push (the retry key derives from it); a deliberate resend later is a new tap with a new id.
   */
  @IsUUID()
  sendId!: string;
}
