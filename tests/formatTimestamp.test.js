const { formatTimestamp } = require('../server');

describe('formatTimestamp', () => {
  it('formats MM:SS correctly when no hours are present (length 2)', () => {
    expect(formatTimestamp('12:35')).toBe('[12:35]');
    expect(formatTimestamp('05:09')).toBe('[05:09]');
  });

  it('formats MM:SS correctly when hours are 00 (length 3)', () => {
    expect(formatTimestamp('00:12:35')).toBe('[12:35]');
    expect(formatTimestamp('0:12:35')).toBe('[12:35]');
  });

  it('formats HH:MM:SS correctly with hours > 0', () => {
    expect(formatTimestamp('01:12:35')).toBe('[01:12:35]');
    expect(formatTimestamp('1:12:35')).toBe('[01:12:35]');
    expect(formatTimestamp('10:12:35')).toBe('[10:12:35]');
    expect(formatTimestamp('123:45:67')).toBe('[123:45:67]'); // Just checking raw processing
  });

  it('removes fractional seconds separated by dot', () => {
    expect(formatTimestamp('00:12:35.450')).toBe('[12:35]');
    expect(formatTimestamp('01:12:35.999')).toBe('[01:12:35]');
    expect(formatTimestamp('12:35.123')).toBe('[12:35]');
  });

  it('removes fractional seconds separated by comma (common in SRT)', () => {
    expect(formatTimestamp('00:12:35,450')).toBe('[12:35]');
    expect(formatTimestamp('01:12:35,999')).toBe('[01:12:35]');
    expect(formatTimestamp('12:35,123')).toBe('[12:35]');
  });

  it('trims whitespace from input strings', () => {
    expect(formatTimestamp('  00:12:35.450  ')).toBe('[12:35]');
    expect(formatTimestamp('\t01:12:35\n')).toBe('[01:12:35]');
  });

  it('returns raw format in brackets for unexpected lengths', () => {
    expect(formatTimestamp('invalid')).toBe('[invalid]');
    expect(formatTimestamp('')).toBe('[]');
    expect(formatTimestamp('01:02:03:04')).toBe('[01:02:03:04]');
  });
});
