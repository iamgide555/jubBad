import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Landing } from './landing';
import { routes } from '../../app.routes';

describe('Landing', () => {
  let component: Landing;
  let fixture: ComponentFixture<Landing>;
  let router: Router;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Landing],
      providers: [provideRouter(routes)],
    }).compileComponents();

    fixture = TestBed.createComponent(Landing);
    component = fixture.componentInstance;
    router = TestBed.inject(Router);
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('startNewGroup navigates to a freshly generated /g/:groupCode', async () => {
    component.startNewGroup();
    await fixture.whenStable();

    expect(router.url).toMatch(/^\/g\/[0-9a-f]{8}$/);
  });

  it('clicking "Start a new group" calls startNewGroup', async () => {
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector(
      'button'
    ) as HTMLButtonElement;
    button.click();
    await fixture.whenStable();

    expect(router.url).toMatch(/^\/g\//);
  });
});
