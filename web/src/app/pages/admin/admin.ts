import { DatePipe } from '@angular/common';
import { Component, ElementRef, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  AdminService,
  type AdminGroup,
  type AdminUser,
  type GroupDisposition,
  type ResetRequest,
} from '../../core/admin.service';
import { AuthService, type Role } from '../../core/auth.service';
import { absoluteUrl, copyToClipboard } from '../../core/share-link';

@Component({
  selector: 'app-admin',
  imports: [FormsModule, DatePipe],
  templateUrl: './admin.html',
  styleUrl: './admin.css',
})
export class Admin {
  private readonly adminService = inject(AdminService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly users = signal<AdminUser[]>([]);
  readonly groups = signal<AdminGroup[]>([]);
  readonly resetRequests = signal<ResetRequest[]>([]);
  readonly loaded = signal(false);
  readonly loadError = signal(false);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [users, groups, resetRequests] = await Promise.all([
        firstValueFrom(this.adminService.listUsers()),
        firstValueFrom(this.adminService.listGroups()),
        firstValueFrom(this.adminService.listResetRequests()),
      ]);
      this.users.set(users);
      this.groups.set(groups);
      this.resetRequests.set(resetRequests);
      this.loadError.set(false);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loaded.set(true);
    }
  }

  async signOut(): Promise<void> {
    await this.auth.logout();
    this.router.navigateByUrl('/login');
  }

  // ---- create user ----

  @ViewChild('createUserDialog') private readonly createUserDialog?: ElementRef<HTMLDialogElement>;

  readonly newEmail = signal('');
  readonly newPassword = signal('');
  readonly newRole = signal<Role>('host');
  readonly createBusy = signal(false);
  readonly createError = signal<string | null>(null);

  /**
   * A modal rather than a form sitting permanently on the page — adding a
   * user is rare, and a form that is always visible competes for attention
   * with the users table underneath it, which is what someone opens this
   * page to actually look at.
   */
  openCreateUser(): void {
    this.newEmail.set('');
    this.newPassword.set('');
    this.newRole.set('host');
    this.createError.set(null);
    this.createUserDialog?.nativeElement.showModal();
  }

  closeCreateUser(): void {
    this.createUserDialog?.nativeElement.close();
  }

  async createUser(): Promise<void> {
    if (!this.newEmail().trim() || this.newPassword().length < 8 || this.createBusy()) return;

    this.createBusy.set(true);
    this.createError.set(null);
    try {
      const user = await firstValueFrom(
        this.adminService.createUser(this.newEmail().trim(), this.newPassword(), this.newRole())
      );
      this.users.update((list) => [...list, user]);
      this.closeCreateUser();
    } catch {
      this.createError.set($localize`:@@admin.createFailed:สร้างผู้ใช้ไม่สำเร็จ — อีเมลนี้อาจถูกใช้แล้ว`);
    } finally {
      this.createBusy.set(false);
    }
  }

  // ---- edit user ----

  readonly editingId = signal<string | null>(null);
  readonly editEmail = signal('');
  readonly editRole = signal<Role>('host');
  readonly editBusy = signal(false);
  readonly editError = signal<string | null>(null);

  startEdit(user: AdminUser): void {
    this.editingId.set(user.id);
    this.editEmail.set(user.email);
    this.editRole.set(user.role);
    this.editError.set(null);
  }

  cancelEdit(): void {
    this.editingId.set(null);
  }

  async saveEdit(user: AdminUser): Promise<void> {
    this.editBusy.set(true);
    this.editError.set(null);
    try {
      const updated = await firstValueFrom(
        this.adminService.updateUser(user.id, {
          email: this.editEmail().trim(),
          role: this.editRole(),
        })
      );
      this.users.update((list) => list.map((u) => (u.id === user.id ? { ...u, ...updated } : u)));
      this.editingId.set(null);
    } catch {
      this.editError.set($localize`:@@admin.editFailed:บันทึกไม่สำเร็จ — อีเมลนี้อาจถูกใช้แล้ว`);
    } finally {
      this.editBusy.set(false);
    }
  }

  async toggleDisabled(user: AdminUser): Promise<void> {
    try {
      const updated = await firstValueFrom(
        this.adminService.setDisabled(user.id, !user.disabled)
      );
      this.users.update((list) => list.map((u) => (u.id === user.id ? { ...u, ...updated } : u)));
    } catch {
      // Left as-is on failure; the table simply keeps showing the last known
      // state rather than guessing at a new one.
    }
  }

  // ---- reset password ----

  readonly resettingId = signal<string | null>(null);
  readonly resetLink = signal<string | null>(null);
  readonly resetCopied = signal(false);
  readonly resetError = signal<string | null>(null);

  async mintReset(user: AdminUser): Promise<void> {
    this.resettingId.set(user.id);
    this.resetLink.set(null);
    this.resetCopied.set(false);
    this.resetError.set(null);
    try {
      const { token } = await firstValueFrom(this.adminService.resetUserPassword(user.id));
      this.resetLink.set(absoluteUrl(`/reset/${token}`));
    } catch {
      this.resetError.set($localize`:@@admin.resetFailed:สร้างลิงก์ไม่สำเร็จ`);
    }
  }

  async copyResetLink(): Promise<void> {
    const link = this.resetLink();
    if (!link) return;
    this.resetCopied.set(await copyToClipboard(link));
  }

  closeReset(): void {
    this.resettingId.set(null);
    this.resetLink.set(null);
  }

  // ---- delete user ----

  readonly deletingUser = signal<AdminUser | null>(null);
  readonly dispositions = signal<Record<string, GroupDisposition | undefined>>({});
  readonly deleteBusy = signal(false);
  readonly deleteError = signal<string | null>(null);

  startDelete(user: AdminUser): void {
    this.deletingUser.set(user);
    this.dispositions.set({});
    this.deleteError.set(null);
  }

  cancelDelete(): void {
    this.deletingUser.set(null);
  }

  setDispositionAction(code: string, action: 'reassign' | 'delete' | 'unassign' | ''): void {
    this.dispositions.update((map) => {
      if (!action) {
        const { [code]: _removed, ...rest } = map;
        return rest;
      }
      if (action === 'reassign') return { ...map, [code]: { action: 'reassign', toUserId: '' } };
      return { ...map, [code]: { action } };
    });
  }

  setDispositionTarget(code: string, toUserId: string): void {
    this.dispositions.update((map) => ({ ...map, [code]: { action: 'reassign', toUserId } }));
  }

  readonly canConfirmDelete = computed(() => {
    const user = this.deletingUser();
    if (!user) return false;
    const map = this.dispositions();
    return user.ownedGroups.every((g) => {
      const entry = map[g.code];
      if (!entry) return false;
      return (
        entry.action === 'delete' ||
        entry.action === 'unassign' ||
        (entry.action === 'reassign' && !!entry.toUserId)
      );
    });
  });

  async confirmDelete(): Promise<void> {
    const user = this.deletingUser();
    if (!user || !this.canConfirmDelete()) return;

    this.deleteBusy.set(true);
    this.deleteError.set(null);
    try {
      const disposition = Object.fromEntries(
        user.ownedGroups.map((g) => [g.code, this.dispositions()[g.code]!])
      );
      await firstValueFrom(this.adminService.deleteUser(user.id, disposition));
      this.users.update((list) => list.filter((u) => u.id !== user.id));
      // Reassigned groups now belong to someone else; deleted ones are gone —
      // either way, re-fetch rather than try to patch this table by hand.
      await this.load();
      this.deletingUser.set(null);
    } catch {
      this.deleteError.set(
        $localize`:@@admin.deleteFailed:ลบไม่สำเร็จ — ต้องระบุการจัดการให้ครบทุกก๊วน`
      );
    } finally {
      this.deleteBusy.set(false);
    }
  }

  // ---- group reassignment (outside the delete flow) ----

  readonly reassigningCode = signal<string | null>(null);
  readonly reassignTarget = signal('');
  readonly reassignError = signal<string | null>(null);

  startReassign(group: AdminGroup): void {
    this.reassigningCode.set(group.code);
    this.reassignTarget.set('');
    this.reassignError.set(null);
  }

  cancelReassign(): void {
    this.reassigningCode.set(null);
  }

  async confirmReassign(group: AdminGroup): Promise<void> {
    if (!this.reassignTarget()) return;
    try {
      await firstValueFrom(this.adminService.reassignGroupOwner(group.code, this.reassignTarget()));
      this.reassigningCode.set(null);
      await this.load();
    } catch {
      this.reassignError.set($localize`:@@admin.reassignFailed:ย้ายเจ้าของไม่สำเร็จ`);
    }
  }

  // ---- reset requests ----

  async handleResetRequest(request: ResetRequest): Promise<void> {
    try {
      await firstValueFrom(this.adminService.handleResetRequest(request.id));
      this.resetRequests.update((list) => list.filter((r) => r.id !== request.id));
    } catch {
      // Left in the list on failure — the admin can just try again.
    }
  }
}
