import { Equals, IsBoolean } from 'class-validator';

export class CloseCollectionDto {
  @IsBoolean()
  @Equals(true)
  confirmDeleteImages!: true;
}
