import { Component, DestroyRef, effect, inject, model, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { VenueService, type VenueOption } from '../../core/venue.service';

const DEBOUNCE_MS = 250;

/**
 * The venue text box with the shared venue list under it. `value` is always
 * exactly what the host typed (or tapped), so the form submits it either way;
 * the list is a convenience, never a gate, and a failed search shows nothing.
 * Linking to a venue happens on the server from the text, not here.
 */
@Component({
  selector: 'app-venue-search',
  imports: [FormsModule],
  templateUrl: './venue-search.html',
  styleUrl: './venue-search.css',
})
export class VenueSearch {
  readonly value = model('');

  private readonly venues = inject(VenueService);
  readonly options = signal<VenueOption[]>([]);
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The text a tapped option just wrote, so choosing it does not reopen the list. */
  private chosen: string | null = null;

  constructor() {
    effect(() => {
      const text = this.value();
      untracked(() => this.schedule(text));
    });
    inject(DestroyRef).onDestroy(() => this.cancel());
  }

  choose(option: VenueOption): void {
    this.chosen = option.displayName;
    this.value.set(option.displayName);
  }

  private schedule(text: string): void {
    this.cancel();
    if (text.trim() === '' || text === this.chosen) {
      this.options.set([]);
      return;
    }
    this.timer = setTimeout(() => this.search(text), DEBOUNCE_MS);
  }

  private search(text: string): void {
    this.venues.search(text).subscribe({
      next: ({ exact, suggestions }) => {
        // A slow answer for text that has since changed would list the wrong venues.
        if (this.value() !== text) return;
        this.options.set(exact ? [exact, ...suggestions] : suggestions);
      },
      error: () => this.options.set([]),
    });
  }

  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
