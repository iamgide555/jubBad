import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SessionDisplay } from './session-display';

describe('SessionDisplay', () => {
  let component: SessionDisplay;
  let fixture: ComponentFixture<SessionDisplay>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionDisplay],
    }).compileComponents();

    fixture = TestBed.createComponent(SessionDisplay);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
