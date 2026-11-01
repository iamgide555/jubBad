import { Component, computed, input, signal } from '@angular/core';

/**
 * A LINE profile picture, or the first letter of the name when there is none or it will not load. LINE's picture
 * host is third-party, so no referrer is sent. Decorative: the name always sits beside it, so it is hidden from
 * assistive tech.
 */
@Component({
  selector: 'app-line-avatar',
  template: `
    @if (showImage()) {
      <img
        [src]="pictureUrl()"
        alt=""
        referrerpolicy="no-referrer"
        [attr.width]="size()"
        [attr.height]="size()"
        (error)="failedUrl.set(pictureUrl())"
      />
    } @else {
      <span class="initial" aria-hidden="true">{{ initial() }}</span>
    }
  `,
  styleUrl: './line-avatar.css',
  host: {
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
    '[style.font-size.px]': 'size() * 0.5',
    'aria-hidden': 'true',
  },
})
export class LineAvatar {
  readonly name = input<string | null>(null);
  readonly pictureUrl = input<string | null>(null);
  readonly size = input(32);

  /** The picture that failed, so a new URL gets its own chance. */
  protected readonly failedUrl = signal<string | null>(null);

  protected readonly showImage = computed(() => {
    const url = this.pictureUrl();
    return !!url && this.failedUrl() !== url;
  });

  protected readonly initial = computed(() => {
    const first = Array.from((this.name() ?? '').trim())[0];
    return first ? first.toLocaleUpperCase() : '?';
  });
}
