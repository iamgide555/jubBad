import { IsIn } from 'class-validator';
import { BILL_MODELS, type BillModel } from '../../../../engines/bill.ts';

/** Change the calculation method without replacing the saved pricing inputs. */
export class SetBillMethodDto {
  @IsIn(BILL_MODELS) model!: BillModel;
}
