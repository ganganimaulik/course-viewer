const { timestampToSeconds } = require('../server.js');

describe('timestampToSeconds', () => {
  // Test HH:MM:SS format
  it('should convert HH:MM:SS correctly', () => {
    expect(timestampToSeconds('01:12:35')).toBe(4355); // 1*3600 + 12*60 + 35
    expect(timestampToSeconds('2:00:00')).toBe(7200);  // 2*3600
    expect(timestampToSeconds('0:00:05')).toBe(5);
  });

  // Test MM:SS format
  it('should convert MM:SS correctly', () => {
    expect(timestampToSeconds('12:35')).toBe(755); // 12*60 + 35
    expect(timestampToSeconds('00:45')).toBe(45);
    expect(timestampToSeconds('5:00')).toBe(300);
  });

  // Edge cases and error handling
  it('should return 0 for invalid formats', () => {
    expect(timestampToSeconds('invalid')).toBe(0);
    expect(timestampToSeconds('')).toBe(0);
    expect(timestampToSeconds('12')).toBe(0); // Only one part
    expect(timestampToSeconds('1:2:3:4')).toBe(0); // Too many parts
  });

  // Handling padded strings
  it('should correctly parse padded strings', () => {
    expect(timestampToSeconds('  10:05 ')).toBe(605);
  });
});
