import { HttpErrorResponse } from '@angular/common/http';
import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { RosterService } from '../../core/roster.service';
import { findOwnDuplicate, sameGroupName, type OwnGroupRow } from '../../core/group-name';
import { PressDirective } from '../../core/motion/press.directive';
import { Icon } from '../../shared/icon/icon';

/**
 * Name-only group creation. Saving here is the whole step: no roster, no
 * settings, no session — the group exists and is reachable from the list
 * the moment the server answers, and the host lands on its home.
 */
@Component({
  selector: 'app-group-create',
  imports: [FormsModule, RouterLink, PressDirective, Icon],
  templateUrl: './group-create.html',
  styleUrl: './group-create.css',
})
export class GroupCreate {
  private readonly roster = inject(RosterService);
  private readonly router = inject(Router);
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  readonly name = signal('');
  readonly error = signal<string | null>(null);
  readonly creating = signal(false);

  /**
   * One code per creation attempt, reused across retries so a lost response
   * cannot make a second group. Replaced only after a 404: the server refused
   * this code for this host, so retrying it would fail forever.
   */
  private code = crypto.randomUUID();

  /**
   * The host's own groups, for the same-name note. Empty when the list could
   * not be read: the note is a courtesy, never a gate on creating.
   */
  private readonly ownGroups = signal<OwnGroupRow[]>([]);
  /** The existing group the note is pointing at; a second submit with this name creates anyway. */
  readonly duplicateOf = signal<{ code: string; name: string } | null>(null);

  constructor() {
    this.roster.listGroups().subscribe({ next: (groups) => this.ownGroups.set(groups), error: () => undefined });
  }

  onNameChange(value: string): void {
    this.name.set(value);
    this.error.set(null);
    this.duplicateOf.set(null);
  }

  async submit(): Promise<void> {
    if (this.creating()) return;
    const name = this.name().trim();
    if (!name) {
      this.error.set($localize`:@@entry.errNoGroupName:กรุณาใส่ชื่อก๊วนก่อน`);
      this.nameInput()?.nativeElement.focus();
      return;
    }
    const warned = this.duplicateOf();
    if (!(warned && sameGroupName(warned.name, name))) {
      const clash = findOwnDuplicate(this.ownGroups(), name);
      if (clash) {
        this.duplicateOf.set(clash);
        return;
      }
    }
    this.error.set(null);
    this.creating.set(true);
    try {
      const group = await firstValueFrom(this.roster.createGroup(this.code, name));
      await this.router.navigateByUrl(`/g/${group.code}`, { replaceUrl: true });
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 404) this.code = crypto.randomUUID();
      this.error.set($localize`:@@group.createFailed:สร้างก๊วนไม่สำเร็จ กรุณาลองอีกครั้ง`);
    } finally {
      this.creating.set(false);
    }
  }
}
