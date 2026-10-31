const { formatTranscriptSegments } = require('../server');

describe('formatTranscriptSegments', () => {
  it('returns an empty string when there are no segments', () => {
    expect(formatTranscriptSegments([])).toBe('');
    expect(formatTranscriptSegments(undefined)).toBe('');
  });

  it('prefixes a paragraph with the start time of its first segment', () => {
    const segments = [{ start: 65.4, end: 70, text: ' Hello there. ' }];
    expect(formatTranscriptSegments(segments)).toBe('[01:05] Hello there.');
  });

  it('merges segments until about 30 seconds have passed and a sentence ends', () => {
    const segments = [
      { start: 0, end: 12, text: 'First sentence.' },
      { start: 12, end: 25, text: 'Second sentence.' },
      { start: 25, end: 34, text: 'Third sentence.' },
      { start: 34, end: 40, text: 'Fourth sentence.' }
    ];
    expect(formatTranscriptSegments(segments)).toBe(
      '[00:00] First sentence. Second sentence. Third sentence.\n\n[00:34] Fourth sentence.'
    );
  });

  it('waits for a sentence end, but breaks after 60 seconds regardless', () => {
    const segments = [
      { start: 0, end: 31, text: 'This keeps going' },
      { start: 31, end: 45, text: 'and going' },
      { start: 45, end: 61, text: 'and going' },
      { start: 61, end: 70, text: 'until it ends.' }
    ];
    expect(formatTranscriptSegments(segments)).toBe(
      '[00:00] This keeps going and going and going\n\n[01:01] until it ends.'
    );
  });

  it('skips empty segments and formats hour-long offsets', () => {
    const segments = [
      { start: 3600, end: 3605, text: '   ' },
      { start: 3605, end: 3610, text: 'Back after the break.' }
    ];
    expect(formatTranscriptSegments(segments)).toBe('[01:00:05] Back after the break.');
  });
});
