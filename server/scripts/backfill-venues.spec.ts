import { describe, expect, it } from 'vitest';
import { parseArgs } from './backfill-venues.mjs';

describe('backfill-venues parseArgs', () => {
  it('reads the owner, repeated --map pairs and --dry-run', () => {
    expect(
      parseArgs(['--owner', 'me@example.test', '--map', 'Bad@Mama=Mama Badminton', '--map', 'วันพฤหัส=KIP Complex', '--dry-run'])
    ).toEqual({
      owner: 'me@example.test',
      groupVenues: [
        { groupName: 'Bad@Mama', venueName: 'Mama Badminton' },
        { groupName: 'วันพฤหัส', venueName: 'KIP Complex' },
      ],
      dryRun: true,
    });
  });

  it('defaults to a real run and splits --map on the first = only', () => {
    expect(parseArgs(['--owner', 'me@example.test', '--map', 'A=B=C'])).toEqual({
      owner: 'me@example.test',
      groupVenues: [{ groupName: 'A', venueName: 'B=C' }],
      dryRun: false,
    });
  });

  it.each([
    [['--map', 'A=B'], /--owner/],
    [['--owner', 'me@example.test', '--map', 'no-equals'], /--map/],
    [['--owner', 'me@example.test', '--map', '=B'], /--map/],
    [['--owner', 'me@example.test', '--map', 'A='], /--map/],
    [['--owner', 'me@example.test', '--map'], /--map/],
    [['--owner'], /--owner/],
    [['--owner', 'me@example.test', '--bogus'], /Unknown argument/],
  ])('rejects bad arguments %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});
