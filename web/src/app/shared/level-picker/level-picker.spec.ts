import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LevelPicker } from './level-picker';

// jsdom 28's HTMLDialogElement implements no showModal()/close() (an empty
// subclass) — compact mode now opens its picker in a <dialog>, so the same
// shim other dialog specs in this app use is needed here too.
beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
});

const BUILT_IN = ['BG', 'N', 'S', 'P-', 'P', 'P+', 'C', 'B'];

describe('LevelPicker', () => {
  let fixture: ComponentFixture<LevelPicker>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [LevelPicker] }).compileComponents();
    fixture = TestBed.createComponent(LevelPicker);
    fixture.componentRef.setInput('levels', BUILT_IN.map((name) => ({ name })));
    fixture.componentRef.setInput('mode', 'standard');
    fixture.detectChanges();
  });

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function chip(text: string): HTMLButtonElement {
    return [...el().querySelectorAll<HTMLButtonElement>('.chip')].find(
      (b) => b.textContent?.trim() === text
    )!;
  }

  it('emits the chosen level and closes', () => {
    let emitted: string | null | undefined;
    fixture.componentInstance.levelChange.subscribe((v) => (emitted = v));

    chip('P+').click();

    expect(emitted).toBe('P+');
  });

  it('emits null for "-"', () => {
    let emitted: string | null | undefined;
    fixture.componentInstance.levelChange.subscribe((v) => (emitted = v));

    chip('-').click();

    expect(emitted).toBeNull();
  });

  it('shows the current level\'s definition', () => {
    fixture.componentRef.setInput('level', 'N');
    fixture.detectChanges();

    expect(el().querySelector('.definition')?.textContent).toContain('รู้กติกา');
  });

  function dialog(): HTMLDialogElement {
    return el().querySelector('dialog') as HTMLDialogElement;
  }

  it('compact mode starts closed and shows a trigger', () => {
    fixture.componentRef.setInput('compact', true);
    fixture.detectChanges();

    expect(el().querySelector('.level-trigger')).not.toBeNull();
    expect(dialog().hasAttribute('open')).toBe(false);
  });

  it('compact mode opens the picker in a modal dialog, not inline', () => {
    fixture.componentRef.setInput('compact', true);
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.level-trigger')!.click();
    fixture.detectChanges();

    expect(dialog().hasAttribute('open')).toBe(true);
    expect(dialog().querySelector('.level-panel')).not.toBeNull();
  });

  it('the "ปิด" button closes the dialog', () => {
    fixture.componentRef.setInput('compact', true);
    fixture.detectChanges();
    el().querySelector<HTMLButtonElement>('.level-trigger')!.click();
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.level-dialog .ghost')!.click();
    fixture.detectChanges();

    expect(dialog().hasAttribute('open')).toBe(false);
  });

  it('compact mode stays open after choosing, showing the picked level\'s definition', () => {
    fixture.componentRef.setInput('compact', true);
    fixture.detectChanges();
    el().querySelector<HTMLButtonElement>('.level-trigger')!.click();
    fixture.detectChanges();

    chip('N').click();
    // The component is display-only for `level` (its parent owns the
    // state and feeds the choice back down) — simulate that round trip,
    // the same way the picked level would come back on the next render.
    fixture.componentRef.setInput('level', 'N');
    fixture.detectChanges();

    expect(dialog().hasAttribute('open')).toBe(true);
    expect(el().querySelector('.definition')?.textContent).toContain('รู้กติกา');
  });

  it('has no helper or definitions-list controls — tapping a level already shows its definition', () => {
    expect(el().querySelector('.helper')).toBeNull();
    expect(el().textContent).not.toContain('ช่วยเลือก');
    expect(el().querySelectorAll('.chip').length).toBe(9); // 8 levels + "-" (unset)
  });

  describe('group ladders (host feedback F)', () => {
    const custom = ['BG', 'BGN', 'N'];
    function useCustom() {
      fixture.componentRef.setInput('levels', custom.map((name) => ({ name })));
      fixture.componentRef.setInput('mode', 'custom');
      fixture.detectChanges();
    }

    it('offers exactly the group\'s levels in the group\'s order, never another group\'s', () => {
      useCustom();
      const chips = [...el().querySelectorAll<HTMLButtonElement>('.chip')].map((b) => b.textContent!.trim());
      expect(chips).toEqual(['-', 'BG', 'BGN', 'N']);
    });

    it('shows built-in definitions only in standard mode and invents none for custom names', () => {
      fixture.componentRef.setInput('level', 'BG');
      fixture.detectChanges();
      expect(el().querySelector('.definition')).toBeTruthy();
      useCustom();
      fixture.componentRef.setInput('level', 'BG');
      fixture.detectChanges();
      expect(el().querySelector('.definition')).toBeNull();
    });

    it('emits a custom name', () => {
      useCustom();
      const emitted: (string | null)[] = [];
      fixture.componentInstance.levelChange.subscribe((l) => emitted.push(l));
      chip('BGN').click();
      expect(emitted).toEqual(['BGN']);
    });

    it('disabled offers nothing selectable and emits nothing', () => {
      fixture.componentRef.setInput('disabled', true);
      fixture.detectChanges();
      const emitted: (string | null)[] = [];
      fixture.componentInstance.levelChange.subscribe((l) => emitted.push(l));
      const chips = [...el().querySelectorAll<HTMLButtonElement>('.chip')];
      expect(chips.every((b) => b.disabled)).toBe(true);
      chips[1].click();
      expect(emitted).toEqual([]);
    });

    it('compact mode\'s trigger is disabled too', () => {
      fixture.componentRef.setInput('compact', true);
      fixture.componentRef.setInput('disabled', true);
      fixture.detectChanges();
      expect((el().querySelector('.level-trigger') as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
