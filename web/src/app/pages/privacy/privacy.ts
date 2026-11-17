import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SignupService } from '../../core/signup.service';

/**
 * What JubBad collects and why, in plain words, for the people who sign up (and the hosts who link LINE). It is a
 * public page: sign-up forms link to it. The contact is whatever the operator configured (`UPGRADE_CONTACT_URL`); the
 * page reads fine without one, but the operator should set it before inviting strangers.
 */
@Component({
  selector: 'app-privacy',
  imports: [RouterLink],
  templateUrl: './privacy.html',
  styleUrl: './privacy.css',
})
export class Privacy implements OnInit {
  private readonly api = inject(SignupService);
  protected readonly contactUrl = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      this.contactUrl.set((await this.api.info()).contactUrl);
    } catch {
      // The page is complete without a contact link.
      this.contactUrl.set(null);
    }
  }
}
