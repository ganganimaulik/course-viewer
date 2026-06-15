const { formatSecondsToTimestamp } = require('./server');

describe('formatSecondsToTimestamp', () => {
  it('formats zero seconds as [00:00]', () => {
    expect(formatSecondsToTimestamp(0)).toBe('[00:00]');
  });

  it('formats less than a minute correctly', () => {
    expect(formatSecondsToTimestamp(45)).toBe('[00:45]');
    expect(formatSecondsToTimestamp(9)).toBe('[00:09]');
  });

  it('formats exact minutes correctly', () => {
    expect(formatSecondsToTimestamp(60)).toBe('[01:00]');
    expect(formatSecondsToTimestamp(600)).toBe('[10:00]');
  });

  it('formats minutes and seconds correctly', () => {
    expect(formatSecondsToTimestamp(65)).toBe('[01:05]');
    expect(formatSecondsToTimestamp(615)).toBe('[10:15]');
  });

  it('formats exactly one hour correctly', () => {
    expect(formatSecondsToTimestamp(3600)).toBe('[01:00:00]');
  });

  it('formats hours, minutes, and seconds correctly', () => {
    expect(formatSecondsToTimestamp(3665)).toBe('[01:01:05]');
    expect(formatSecondsToTimestamp(36605)).toBe('[10:10:05]');
  });

  it('handles floating point seconds correctly by truncating the decimal part', () => {
    expect(formatSecondsToTimestamp(12.5)).toBe('[00:12]');
    expect(formatSecondsToTimestamp(65.9)).toBe('[01:05]');
    expect(formatSecondsToTimestamp(3665.123)).toBe('[01:01:05]');
  });
});
