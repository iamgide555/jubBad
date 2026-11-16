import { Component, input } from '@angular/core';

/**
 * The invitation to link LINE for the 30-day trial, shown to a free host who has not had one. The link is the
 * LIFF page that does the linking; the server only offers the trial when it has a link to send them to.
 */
@Component({
  selector: 'app-trial-offer',
  templateUrl: './trial-offer.html',
  styleUrl: './trial-offer.css',
})
export class TrialOffer {
  readonly linkUrl = input.required<string>();
}
