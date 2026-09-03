import { ComponentFixture, TestBed } from '@angular/core/testing';
import { GroupEntry } from './group-entry';

describe('GroupEntry', () => {
  let component: GroupEntry;
  let fixture: ComponentFixture<GroupEntry>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GroupEntry],
    }).compileComponents();

    fixture = TestBed.createComponent(GroupEntry);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
