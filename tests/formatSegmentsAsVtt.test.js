const { formatSegmentsAsVtt } = require('../server');

describe('formatSegmentsAsVtt', () => {
  it('returns just the header when there are no segments', () => {
    expect(formatSegmentsAsVtt([])).toBe('WEBVTT\n\n\n');
    expect(formatSegmentsAsVtt(undefined)).toBe('WEBVTT\n\n\n');
  });

  it('writes one cue per short sentence with WebVTT timestamps', () => {
    const segments = [
      { start: 1.5, end: 4, text: ' Hello there. ' },
      { start: 3725.25, end: 3727, text: 'An hour in.' }
    ];
    expect(formatSegmentsAsVtt(segments)).toBe(
      'WEBVTT\n\n' +
      '00:00:01.500 --> 00:00:04.000\nHello there.\n\n' +
      '01:02:05.250 --> 01:02:07.000\nAn hour in.\n'
    );
  });

  it('splits long sentences into cues timed by their share of the text', () => {
    const text = 'one two three four five six seven eight';
    const cues = formatSegmentsAsVtt([{ start: 0, end: 8, text }], 20).split('\n\n').slice(1);
    expect(cues.map((cue) => cue.split('\n')[1])).toEqual(['one two three four', 'five six seven eight']);
    // The first piece and its space are 19 of the 39 characters, so it gets 19/39 of the 8 seconds
    expect(cues[0].split('\n')[0]).toBe('00:00:00.000 --> 00:00:03.897');
    expect(cues[1].split('\n')[0]).toBe('00:00:03.897 --> 00:00:08.000');
  });

  it('escapes characters that WebVTT treats as markup', () => {
    const vtt = formatSegmentsAsVtt([{ start: 0, end: 1, text: 'if a < b && b > c' }]);
    expect(vtt).toContain('if a &lt; b &amp;&amp; b &gt; c');
  });

  it('skips segments without text', () => {
    expect(formatSegmentsAsVtt([{ start: 0, end: 1, text: '   ' }])).toBe('WEBVTT\n\n\n');
  });
});
