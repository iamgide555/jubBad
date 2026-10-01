import { lastShuttleFor, pickableShuttles, type ShuttleInventory } from './shuttle.model';

const inventory = (over: Partial<ShuttleInventory> = {}): ShuttleInventory => ({
  enabled: true,
  identities: [
    { id: 's1', number: 1, usable: true, voided: false },
    { id: 's2', number: 2, usable: true, voided: false },
    { id: 's3', number: 3, usable: false, voided: false },
    { id: 's4', number: 4, usable: true, voided: true },
    { id: 's5', number: 5, usable: true, voided: false },
  ],
  games: [],
  heldShuttleIds: [],
  lastShuttleByCourt: [],
  ...over,
});

describe('pickableShuttles', () => {
  it('offers usable, unvoided, idle shuttles in number order', () => {
    expect(pickableShuttles(inventory({ heldShuttleIds: ['s2'] })).map((s) => s.number)).toEqual([1, 5]);
  });

  it('keeps a shuttle the caller already holds selectable', () => {
    expect(pickableShuttles(inventory({ heldShuttleIds: ['s2'] }), 's2').map((s) => s.number)).toEqual([1, 2, 5]);
  });

  it('can leave the held one out when switching away from it', () => {
    expect(pickableShuttles(inventory(), undefined, 's1').map((s) => s.number)).toEqual([2, 5]);
  });

  it('is empty when tracking is off', () => {
    expect(pickableShuttles(inventory({ enabled: false }))).toEqual([]);
  });
});

describe('lastShuttleFor', () => {
  it('returns the court\'s last shuttle when it is usable and idle', () => {
    const inv = inventory({ lastShuttleByCourt: [{ courtNumber: 1, shuttleId: 's2' }] });
    expect(lastShuttleFor(inv, 1)).toEqual({ id: 's2', number: 2 });
  });

  it('returns null when it is retired, held elsewhere, voided, or the court has none', () => {
    expect(lastShuttleFor(inventory({ lastShuttleByCourt: [{ courtNumber: 1, shuttleId: 's3' }] }), 1)).toBeNull();
    expect(lastShuttleFor(inventory({ lastShuttleByCourt: [{ courtNumber: 1, shuttleId: 's2' }], heldShuttleIds: ['s2'] }), 1)).toBeNull();
    expect(lastShuttleFor(inventory({ lastShuttleByCourt: [{ courtNumber: 1, shuttleId: 's4' }] }), 1)).toBeNull();
    expect(lastShuttleFor(inventory(), 2)).toBeNull();
  });
});
