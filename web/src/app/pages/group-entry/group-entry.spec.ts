import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { GroupEntry } from './group-entry';
import { routes } from '../../app.routes';

describe('GroupEntry', () => {
  let component: GroupEntry;
  let fixture: ComponentFixture<GroupEntry>;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [GroupEntry],
      providers: [
        provideRouter(routes),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ groupCode: 'group1' }) },
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(GroupEntry);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('starts in the paste state', () => {
    expect(component.state()).toBe('paste');
  });

  it('parsing a roster message switches to the confirm state', () => {
    component.rawText.set(
      '1. ตั้ม\n2. เบส\n19.00-20.00 1 คอร์ท\n@All'
    );
    component.parse();
    expect(component.state()).toBe('confirm');
  });
});
