const { formatTime } = require('../public/app.js');

describe('formatTime', () => {
  it('formats standard MM:SS correctly', () => {
    expect(formatTime(65)).toBe('01:05');
    expect(formatTime(12)).toBe('00:12');
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(59)).toBe('00:59');
  });

  it('formats standard HH:MM:SS correctly', () => {
    expect(formatTime(3600)).toBe('01:00:00');
    expect(formatTime(3665)).toBe('01:01:05');
    expect(formatTime(7200)).toBe('02:00:00');
    expect(formatTime(36000)).toBe('10:00:00');
  });

  it('handles negative values correctly by returning 00:00', () => {
    expect(formatTime(-1)).toBe('00:00');
    expect(formatTime(-3600)).toBe('00:00');
  });

  it('handles floating point values correctly', () => {
    expect(formatTime(65.5)).toBe('01:05');
    expect(formatTime(12.9)).toBe('00:12');
  });

  it('handles NaN correctly', () => {
    expect(formatTime(NaN)).toBe('00:00');
  });

  it('handles other non-numeric inputs gracefully', () => {
    expect(formatTime(undefined)).toBe('00:00');
    expect(formatTime(null)).toBe('00:00');
    expect(formatTime('abc')).toBe('00:00');
    expect(formatTime('123')).toBe('00:00'); // Assuming string input is rejected
    expect(formatTime({})).toBe('00:00');
    expect(formatTime([])).toBe('00:00');
  });
});
