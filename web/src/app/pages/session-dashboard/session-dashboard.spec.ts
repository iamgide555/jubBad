import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SessionDashboard } from './session-dashboard';

describe('SessionDashboard', () => {
  let component: SessionDashboard;
  let fixture: ComponentFixture<SessionDashboard>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionDashboard],
    }).compileComponents();

    fixture = TestBed.createComponent(SessionDashboard);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
