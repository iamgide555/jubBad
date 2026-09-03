import { Component, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { parseLineRosterMessage } from '../../../../../parser.ts';

@Component({
  selector: 'app-group-entry',
  imports: [FormsModule],
  templateUrl: './group-entry.html',
  styleUrl: './group-entry.css',
})
export class GroupEntry {
  protected readonly groupCode: string;
  readonly state = signal<'paste' | 'confirm'>('paste');
  readonly rawText = signal('');

  constructor(route: ActivatedRoute) {
    this.groupCode = route.snapshot.paramMap.get('groupCode')!;
  }

  parse(): void {
    parseLineRosterMessage(this.rawText());
    this.state.set('confirm');
  }
}
