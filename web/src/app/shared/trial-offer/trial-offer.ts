import { Component, input } from '@angular/core';
import { Icon } from '../icon/icon';

/**
 * The invitation to link LINE for the 30-day trial, shown to a free host who has not had one. The link is the
 * LIFF page that does the linking; the server only offers the trial when it has a link to send them to.
 * A gift, not an alert: it says what the trial includes and what linking also gives them.
 */
@Component({
  selector: 'app-trial-offer',
  imports: [Icon],
  templateUrl: './trial-offer.html',
  styleUrl: './trial-offer.css',
})
export class TrialOffer {
  readonly linkUrl = input.required<string>();
}
