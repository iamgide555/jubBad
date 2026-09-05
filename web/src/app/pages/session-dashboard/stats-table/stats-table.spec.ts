import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { StatsTable } from './stats-table';
import { environment } from '../../../../environments/environment';

const B = environment.apiBaseUrl;

describe('StatsTable', () => {
  let fixture: ComponentFixture<StatsTable>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [StatsTable],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(StatsTable);
    fixture.componentRef.setInput('sessionCode', 'sess1');
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
});
