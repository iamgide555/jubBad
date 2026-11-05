import { ArrayMaxSize, IsArray, IsNotEmpty, IsString } from 'class-validator';

/** The pay page's "this slip covers these people". An empty list is the service's refusal, not a shape error. */
export class SlipCoverDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  playerIds!: string[];
}
