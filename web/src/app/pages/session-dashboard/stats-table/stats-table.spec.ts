import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { StatsTable } from './stats-table';
import { environment } from '../../../../environments/environment';

const B = environment.apiBaseUrl;

describe('StatsTable', () => {
  let fixture: ComponentFixture<StatsTable>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [StatsTable],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(StatsTable);
    fixture.componentRef.setInput('sessionCode', 'sess1');
    fixture.componentRef.setInput('groupCode', 'group1');
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('defaults to session scope and renders rows', async () => {
    fixture.detectChanges();
    httpMock
      .expectOne(`${B}/sessions/sess1/stats?scope=session`)
      .flush([{ playerId: 'p1', name: 'Alice', played: 3, won: 2 }]);
    await fixture.whenStable();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Alice');
    expect(text).toContain('3');
    expect(text).toContain('2');
  });

  it('switches to all-time scope on toggle click', async () => {
    fixture.detectChanges();
    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=session`).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
    const allTimeButton = Array.from(buttons).find(
      (b) => b.textContent?.trim() === 'ทั้งหมด'
    ) as HTMLButtonElement;
    allTimeButton.click();
    fixture.detectChanges();

    httpMock.expectOne(`${B}/sessions/sess1/stats?scope=all`).flush([]);
    await fixture.whenStable();
  });

  it('offers a share link for each player and copies their card URL', async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (t: string) => void copied.push(t) },
      configurable: true,
    });

    fixture.detectChanges();
    httpMock
      .expectOne(`${B}/sessions/sess1/stats?scope=session`)
      .flush([{ playerId: 'p1', name: 'Alice', played: 3, won: 2 }]);
    await fixture.whenStable();
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.share-player') as HTMLButtonElement;
    expect(button).toBeTruthy();
    button.click();
    await fixture.whenStable();

    // A player cannot reach their own card from anywhere in the app — the only
    // link to it lives on this admin-only screen — so the point of the button
    // is producing something sendable.
    expect(copied).toEqual([`${location.origin}/g/group1/p/p1`]);
  });

  it('names the player in the share button, so a row of icons is not ambiguous', async () => {
    fixture.detectChanges();
    httpMock
      .expectOne(`${B}/sessions/sess1/stats?scope=session`)
      .flush([{ playerId: 'p1', name: 'Alice', played: 3, won: 2 }]);
    await fixture.whenStable();
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.share-player') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toContain('Alice');
  });
});
