import { TestBed } from '@angular/core/testing';
import { RosterDraftService, type RosterDraft } from './roster-draft.service';

function draft(rawText: string): RosterDraft {
  return {
    state: 'paste',
    rawText,
    date: '',
    venue: '',
    courtCount: null,
    warnings: [],
    unrecognizedLines: [],
    rosterReviews: [],
    waitlistReviews: [],
    players: [],
    manualReviews: new Set(),
    openReviews: new Set(),
    idempotencyKey: null,
  };
}

describe('RosterDraftService', () => {
  let drafts: RosterDraftService;
  beforeEach(() => (drafts = TestBed.inject(RosterDraftService)));

  it('has nothing for a group until something is saved', () => {
    expect(drafts.get('g1')).toBeNull();
  });

  it('keeps one draft per group', () => {
    drafts.save('g1', draft('one'));
    drafts.save('g2', draft('two'));
    expect(drafts.get('g1')?.rawText).toBe('one');
    expect(drafts.get('g2')?.rawText).toBe('two');
  });

  it('clears only the named group', () => {
    drafts.save('g1', draft('one'));
    drafts.save('g2', draft('two'));
    drafts.clear('g1');
    expect(drafts.get('g1')).toBeNull();
    expect(drafts.get('g2')?.rawText).toBe('two');
  });
});
