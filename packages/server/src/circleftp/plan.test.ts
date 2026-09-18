import { describe, expect, it } from 'vitest';

import { buildPlan } from './plan.js';
import type { RawPost } from './types.js';

const seriesPost: RawPost = {
  id: 1,
  name: 'Example Show',
  title: 'Example Show (2021) 1080p',
  type: 'series',
  year: '2021',
  content: [
    {
      seasonName: 'Season 1',
      episodes: [
        { title: 'Episode 1', link: 'http://ftp3.circleftp.net/index2/s/ep1.mkv' },
        { title: 'Episode 2', link: 'http://ftp3.circleftp.net/index2/s/ep2.mkv' },
      ],
    },
    {
      seasonName: 'Season 2',
      episodes: [{ title: 'Episode 1', link: 'http://ftp3.circleftp.net/index2/s2/ep1.mkv' }],
    },
  ],
};

describe('buildPlan — series', () => {
  it('lays episodes out as Season NN/<Show> SxxEyy - <file>', () => {
    const plan = buildPlan(seriesPost);

    expect(plan.folder).toBe('Example Show (2021)');
    expect(plan.files.map((file) => file.relPath)).toEqual([
      'Season 01/Example Show S01E01 - ep1.mkv',
      'Season 01/Example Show S01E02 - ep2.mkv',
      'Season 02/Example Show S02E01 - ep1.mkv',
    ]);
  });

  it('reports every season regardless of the selection', () => {
    const plan = buildPlan(seriesPost, ['1']);

    expect(plan.seasons).toEqual([
      { name: 'Season 1', number: 1, episodeCount: 2 },
      { name: 'Season 2', number: 2, episodeCount: 1 },
    ]);
    // ...but only downloads the selected one.
    expect(plan.files).toHaveLength(2);
    expect(plan.files.every((file) => file.relPath.startsWith('Season 01/'))).toBe(true);
  });

  it('accepts a season selected by name as well as by number', () => {
    expect(buildPlan(seriesPost, ['Season 2']).files).toHaveLength(1);
  });

  it('does not double up an SxxEyy marker the upload already has', () => {
    const plan = buildPlan({
      ...seriesPost,
      content: [
        {
          seasonName: 'Season 1',
          episodes: [{ title: 'Episode 1', link: 'http://h/Example.Show.S01E01.1080p.mkv' }],
        },
      ],
    });

    expect(plan.files[0]?.relPath).toBe('Season 01/Example.Show.S01E01.1080p.mkv');
  });

  it('uses the episode number from the title, not the position', () => {
    const plan = buildPlan({
      ...seriesPost,
      content: [
        {
          seasonName: 'Season 1',
          episodes: [
            { title: 'Episode 7', link: 'http://h/a.mkv' },
            { title: 'Episode 8', link: 'http://h/b.mkv' },
          ],
        },
      ],
    });

    expect(plan.files.map((file) => file.episode)).toEqual([7, 8]);
    expect(plan.files[0]?.relPath).toContain('S01E07');
  });

  it('skips episodes with no link', () => {
    const plan = buildPlan({
      ...seriesPost,
      content: [
        {
          seasonName: 'Season 1',
          episodes: [{ title: 'Episode 1' }, { title: 'Episode 2', link: 'http://h/b.mkv' }],
        },
      ],
    });

    expect(plan.files).toHaveLength(1);
    // The surviving episode keeps its own number rather than being renumbered.
    expect(plan.files[0]?.episode).toBe(2);
  });

  it('falls back to the season name when it carries no number', () => {
    const plan = buildPlan({
      ...seriesPost,
      content: [{ seasonName: 'Specials', episodes: [{ title: 'One', link: 'http://h/x.mkv' }] }],
    });

    expect(plan.files[0]?.relPath).toBe('Specials/x.mkv');
  });
});

describe('buildPlan — movies and files', () => {
  it('puts a singleVideo straight in the title folder', () => {
    const plan = buildPlan({
      id: 98217,
      name: 'Inception',
      title: 'Inception (2010) 1080p BluRay Dual Audio',
      type: 'singleVideo',
      year: '2010',
      content: 'http://ftp3.circleftp.net/index2/m/Inception.2010.1080p.mkv',
    });

    expect(plan.folder).toBe('Inception (2010)');
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.relPath).toBe('Inception.2010.1080p.mkv');
    expect(plan.files[0]?.season).toBeNull();
  });

  it('handles multiVideo parts', () => {
    const plan = buildPlan({
      id: 2,
      name: 'Two Parter',
      type: 'multiVideo',
      year: '2020',
      content: [
        { title: 'Part 1', link: 'http://h/p1.mkv' },
        { title: 'Part 2', link: 'http://h/p2.mkv' },
      ],
    });

    expect(plan.files.map((file) => file.relPath)).toEqual(['p1.mkv', 'p2.mkv']);
  });

  it('is generous with an unknown type that still carries a URL', () => {
    const plan = buildPlan({ id: 3, name: 'Mystery', type: 'somethingNew', content: 'http://h/f.bin' });
    expect(plan.files).toHaveLength(1);
  });

  it('returns no files when content is missing or empty', () => {
    expect(buildPlan({ id: 4, name: 'Empty', type: 'singleVideo', content: '' }).files).toEqual([]);
    expect(buildPlan({ id: 5, name: 'Empty', type: 'series', content: null }).files).toEqual([]);
  });
});

describe('buildPlan — de-duplication', () => {
  it('suffixes colliding names before the extension', () => {
    const plan = buildPlan({
      id: 6,
      name: 'Dupes',
      type: 'multiVideo',
      content: [
        { title: 'a', link: 'http://h1/same.mkv' },
        { title: 'b', link: 'http://h2/same.mkv' },
        { title: 'c', link: 'http://h3/same.mkv' },
      ],
    });

    // Nothing may silently overwrite anything else.
    expect(plan.files.map((file) => file.relPath)).toEqual([
      'same.mkv',
      'same (2).mkv',
      'same (3).mkv',
    ]);
  });

  it('suffixes at the end when there is no extension', () => {
    const plan = buildPlan({
      id: 7,
      name: 'Dupes',
      type: 'multiFile',
      content: [
        { title: 'a', link: 'http://h1/readme' },
        { title: 'b', link: 'http://h2/readme' },
      ],
    });

    expect(plan.files.map((file) => file.relPath)).toEqual(['readme', 'readme (2)']);
  });

  it('does not mistake a dot in a directory name for an extension', () => {
    const plan = buildPlan({
      id: 8,
      name: 'Show',
      type: 'series',
      content: [
        {
          seasonName: 'Specials',
          episodes: [
            { title: 'x', link: 'http://h1/clip' },
            { title: 'x', link: 'http://h2/clip' },
          ],
        },
      ],
    });

    expect(plan.files.map((file) => file.relPath)).toEqual(['Specials/clip', 'Specials/clip (2)']);
  });
});
