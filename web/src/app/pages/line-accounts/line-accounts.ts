import { HttpErrorResponse } from '@angular/common/http';
import { Component, ElementRef, LOCALE_ID, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LineAccountsService, type LineAccountRow } from '../../core/line-accounts.service';
import { formatPostedAt } from '../../core/line.model';
import { RosterService, type ManagedPlayer } from '../../core/roster.service';
import { LineAvatar } from '../../shared/line-avatar/line-avatar';

type Filter = 'all' | 'unlinked';

/**
 * Every LINE account the group has seen (a roster post, a slip, a player's own claim, a host link), with who each is
 * linked to. A sub-route of จัดการผู้เล่น so the phone's back button closes it. Linking or unlinking updates the row in
 * place; nothing reloads, and the row never disappears from "all".
 */
@Component({
  selector: 'app-line-accounts',
  imports: [RouterLink, LineAvatar],
  templateUrl: './line-accounts.html',
  styleUrl: './line-accounts.css',
})
export class LineAccounts {
  private readonly accountsService = inject(LineAccountsService);
  private readonly rosterService = inject(RosterService);
  private readonly locale = inject(LOCALE_ID);

  protected readonly groupCode = inject(ActivatedRoute).snapshot.paramMap.get('groupCode')!;

  protected readonly accounts = signal<LineAccountRow[] | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly filter = signal<Filter>('all');
  protected readonly error = signal<string | null>(null);
  /** One lock for the whole page: while any list read, link or unlink is in flight, every action waits. */
  protected readonly busy = signal(false);

  protected readonly visible = computed(() => {
    const all = this.accounts() ?? [];
    return this.filter() === 'unlinked' ? all.filter((a) => a.player === null) : all;
  });

  // ---- player picker ----

  private readonly dialogEl = viewChild.required<ElementRef<HTMLDialogElement>>('playerDialog');
  protected readonly pickerOpen = signal(false);
  /** The group's players, read the first time the picker opens and kept in step with every link and unlink. */
  private readonly players = signal<ManagedPlayer[] | null>(null);
  private targetAccountId: string | null = null;

  /** Players with no LINE account first (the likely target); then those who have one, whom a pick would move. */
  protected readonly pickable = computed(() => {
    const all = this.players() ?? [];
    return [...all.filter((p) => p.lineAccount === null), ...all.filter((p) => p.lineAccount !== null)];
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.busy.set(true);
    try {
      this.accounts.set(await firstValueFrom(this.accountsService.list(this.groupCode)));
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.busy.set(false);
    }
  }

  protected setFilter(filter: Filter): void {
    this.filter.set(filter);
    this.error.set(null);
  }

  // ---- row presentation ----

  protected seen(account: LineAccountRow): string {
    return formatPostedAt(account.lastSeenAt, new Date(), this.locale);
  }

  protected sourceLabel(source: LineAccountRow['source']): string {
    switch (source) {
      case 'roster':
        return $localize`:@@lineAccounts.sourceRoster:รายชื่อ`;
      case 'slip':
        return $localize`:@@lineAccounts.sourceSlip:สลิป`;
      case 'claim':
        return $localize`:@@lineAccounts.sourceClaim:ผู้เล่นยืนยัน`;
      case 'host':
        return $localize`:@@lineAccounts.sourceHost:ผู้จัด`;
      case 'link':
        return $localize`:@@lineAccounts.sourceLink:เชื่อมกลุ่ม`;
    }
  }

  private nameOf(account: LineAccountRow): string {
    return account.displayName ?? $localize`:@@lineAccountPicker.unknownName:ไม่ทราบชื่อ`;
  }

  protected linkLabel(account: LineAccountRow): string {
    const name = this.nameOf(account);
    return $localize`:@@lineAccounts.linkLabel:ผูก ${name}:name: กับผู้เล่น`;
  }

  protected unlinkLabel(account: LineAccountRow): string {
    const name = account.player?.name ?? '';
    return $localize`:@@lineAccounts.unlinkLabel:ยกเลิกการผูก LINE ของ ${name}:name:`;
  }

  // ---- link / unlink ----

  protected async openPicker(account: LineAccountRow): Promise<void> {
    if (this.busy()) return;
    this.error.set(null);
    this.targetAccountId = account.id;
    if (this.players() === null) {
      this.busy.set(true);
      try {
        this.players.set(await firstValueFrom(this.rosterService.getPlayersManage(this.groupCode)));
      } catch {
        this.error.set($localize`:@@lineAccounts.playersLoadFailed:โหลดรายชื่อผู้เล่นไม่สำเร็จ`);
        return;
      } finally {
        this.busy.set(false);
      }
    }
    this.pickerOpen.set(true);
    this.dialogEl().nativeElement.showModal();
  }

  protected closePicker(): void {
    this.dialogEl().nativeElement.close();
  }

  /** Native close (Esc, the close button, a pick) lands here once, whichever way the dialog went. */
  protected onDialogClose(): void {
    this.pickerOpen.set(false);
  }

  protected async pickPlayer(player: ManagedPlayer): Promise<void> {
    const accountId = this.targetAccountId;
    const account = this.accounts()?.find((a) => a.id === accountId);
    this.closePicker();
    if (!account || this.busy()) return;
    this.error.set(null);
    this.busy.set(true);
    try {
      await firstValueFrom(this.accountsService.link(this.groupCode, account.id, player.id));
      const lineAccount = {
        id: account.id,
        displayName: account.displayName,
        pictureUrl: account.pictureUrl,
        linkedBy: 'host' as const,
      };
      this.accounts.update((list) =>
        (list ?? []).map((a) => {
          if (a.id === account.id) return { ...a, player: { id: player.id, name: player.name, linkedBy: 'host' as const } };
          // The server replaced this player's old account: it is listed on, unlinked.
          if (a.player?.id === player.id) return { ...a, player: null };
          return a;
        })
      );
      this.players.update((list) => (list ?? []).map((p) => (p.id === player.id ? { ...p, lineAccount } : p)));
    } catch (err) {
      const code = err instanceof HttpErrorResponse && typeof err.error?.code === 'string' ? err.error.code : null;
      this.error.set(
        code === 'ACCOUNT_ALREADY_LINKED'
          ? $localize`:@@playerRoster.lineAlreadyLinked:บัญชีนี้ผูกกับผู้เล่นคนอื่นแล้ว`
          : $localize`:@@playerRoster.saveFailed:บันทึกไม่สำเร็จ`
      );
      if (code === 'ACCOUNT_ALREADY_LINKED') await this.refreshAfterConflict();
    } finally {
      this.busy.set(false);
    }
  }

  /** The account was taken since this page last read it: read both lists again so the rows show who holds it now. */
  private async refreshAfterConflict(): Promise<void> {
    try {
      const [accounts, players] = await Promise.all([
        firstValueFrom(this.accountsService.list(this.groupCode)),
        firstValueFrom(this.rosterService.getPlayersManage(this.groupCode)),
      ]);
      this.accounts.set(accounts);
      this.players.set(players);
    } catch {
      // The conflict message stays; the lists keep what they had.
    }
  }

  protected async unlink(account: LineAccountRow): Promise<void> {
    if (this.busy()) return;
    this.error.set(null);
    this.busy.set(true);
    try {
      await firstValueFrom(this.accountsService.unlink(this.groupCode, account.id));
      this.accounts.update((list) => (list ?? []).map((a) => (a.id === account.id ? { ...a, player: null } : a)));
      this.players.update((list) =>
        list === null ? null : list.map((p) => (p.lineAccount?.id === account.id ? { ...p, lineAccount: null } : p))
      );
    } catch {
      this.error.set($localize`:@@playerRoster.saveFailed:บันทึกไม่สำเร็จ`);
    } finally {
      this.busy.set(false);
    }
  }
}
