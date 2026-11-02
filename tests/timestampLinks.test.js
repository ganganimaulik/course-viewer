const { compactTimestampLinks, expandTimestampLinks, stripTimestampLinks } = require('../server');

describe('timestamp link tags for course-level prompts', () => {
  const notes = '- [00:30](timestamp:Week%201%2Fintro.mp4#30) Welcome.\n' +
    '- [01:02:05](timestamp:Week%201%2Fintro.mp4#3725) Wrap-up.\n' +
    '- [12:35](timestamp:Lesson%20(part%202).mp4#755) Parentheses in the name.';

  it('gives each lesson one short tag', () => {
    const lessons = new Map();
    expect(compactTimestampLinks(notes, lessons)).toBe(
      '- [L1 00:30] Welcome.\n- [L1 01:02:05] Wrap-up.\n- [L2 12:35] Parentheses in the name.');
    expect([...lessons.values()]).toEqual(['L1', 'L2']);
  });

  it('turns the tags in a reply back into the same links', () => {
    const lessons = new Map();
    expect(expandTimestampLinks(compactTimestampLinks(notes, lessons), lessons)).toBe(notes);
  });

  it('keeps ids across calls with the same map, e.g. for earlier chat replies', () => {
    const lessons = new Map();
    compactTimestampLinks(notes, lessons);
    expect(compactTimestampLinks('See [00:10](timestamp:other.mp4#10) and [05:00](timestamp:Week%201%2Fintro.mp4#300).', lessons))
      .toBe('See [L3 00:10] and [L1 05:00].');
  });

  it('shows a tag for a lesson it was never given as a plain time', () => {
    expect(expandTimestampLinks('As shown [L7 04:15].', new Map())).toBe('As shown 04:15.');
  });

  it('leaves plain timestamps and other links alone', () => {
    const text = 'At [04:15], see [docs](https://example.com).';
    expect(compactTimestampLinks(text, new Map())).toBe(text);
  });
});

describe('stripTimestampLinks', () => {
  it('turns links back into the stamps a lesson chat wrote', () => {
    expect(stripTimestampLinks('Covered at [12:35](timestamp:Week%201%2Fintro.mp4#755) and [01:00:00](timestamp:a.mp4#3600).'))
      .toBe('Covered at [12:35] and [01:00:00].');
  });
});
