const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Load the server against a throwaway db.json, so these tests can add a watched folder and save progress
// without touching the real one. server.js creates the file on load; stop here if it didn't.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-viewer-test-'));
process.env.COURSE_VIEWER_DB = path.join(tmpDir, 'db.json');
const { app } = require('../server');
if (!fs.existsSync(process.env.COURSE_VIEWER_DB)) {
  throw new Error('server.js ignored COURSE_VIEWER_DB; refusing to run against the real db.json');
}

const libraryDir = path.join(tmpDir, 'library');
const courseDir = path.join(libraryDir, 'Course A');
const videoPath = path.join(courseDir, 'lesson.mp4');
const pagePath = path.join(courseDir, 'page.html');
const looseVideoPath = path.join(libraryDir, 'loose.mp4');
const outsideFile = path.join(tmpDir, 'secret.txt');
const size = 1000;

let server;
let baseUrl;

const postJson = (route, body, headers = {}) => fetch(`${baseUrl}${route}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

beforeAll(async () => {
  fs.mkdirSync(courseDir, { recursive: true });
  fs.writeFileSync(videoPath, Buffer.alloc(size, 7));
  fs.writeFileSync(pagePath, '<p>Lesson</p><script>fetch("/api/progress/reset", { method: "POST" })</script>');
  fs.writeFileSync(looseVideoPath, Buffer.alloc(10, 7));
  fs.writeFileSync(outsideFile, 'not for the API');
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  expect((await postJson('/api/config', { path: libraryDir })).status).toBe(200);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.COURSE_VIEWER_DB;
});

describe('video streaming', () => {
  const getVideo = (range) => fetch(`${baseUrl}/api/video?path=${encodeURIComponent(videoPath)}`, {
    headers: { Range: range }
  });

  it('serves a byte range', async () => {
    const res = await getVideo('bytes=100-199');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 100-199/${size}`);
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it('clamps a range that ends past the end of the file', async () => {
    const res = await getVideo('bytes=900-99999999');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 900-999/${size}`);
    expect(res.headers.get('content-length')).toBe('100');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it('serves suffix ranges', async () => {
    const res = await getVideo('bytes=-300');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 700-999/${size}`);
    expect((await res.arrayBuffer()).byteLength).toBe(300);
  });

  it('rejects unsatisfiable ranges with 416', async () => {
    for (const range of [`bytes=${size}-`, 'bytes=500-100', 'bytes=abc']) {
      const res = await getVideo(range);
      expect(res.status).toBe(416);
      expect(res.headers.get('content-range')).toBe(`bytes */${size}`);
    }
  });
});

describe('file serving', () => {
  it('returns 404 for a directory instead of crashing the server', async () => {
    const res = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(courseDir)}`);
    expect(res.status).toBe(404);

    const next = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(videoPath)}`);
    expect(next.status).toBe(200);
  });

  it('refuses files outside the watched folders, including via ".."', async () => {
    for (const filePath of [outsideFile, path.join(libraryDir, '..', 'secret.txt')]) {
      const res = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(filePath)}`);
      expect(res.status).toBe(403);
    }
  });

  it('serves lesson pages with a policy that blocks their scripts and form posts', async () => {
    const res = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(pagePath)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toBe("script-src 'none'; form-action 'none'");
  });

  it('accepts JSON bodies over 100kb, like the file list of a large course', async () => {
    const paths = Array.from({ length: 2000 }, (_, i) => path.join(libraryDir, `missing-${i}-${'x'.repeat(60)}.html`));
    const res = await postJson('/api/video/pregenerate-summaries', { paths });
    expect(res.status).toBe(200);
    expect((await res.json()).queuedCount).toBe(0);
  });
});

describe('access control', () => {
  it('sends no CORS headers, so other sites cannot read responses', async () => {
    const res = await fetch(`${baseUrl}/api/config`, { headers: { Origin: 'https://example.com' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects changes coming from other sites', async () => {
    const res = await fetch(`${baseUrl}/api/progress/reset`, {
      method: 'POST',
      headers: { Origin: 'https://example.com' }
    });
    expect(res.status).toBe(403);
  });

  it('rejects requests addressed to another host name (DNS rebinding)', async () => {
    const status = await new Promise((resolve, reject) => {
      http.get(`${baseUrl}/api/config`, { headers: { Host: 'attacker.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    expect(status).toBe(403);
  });
});

describe('course reset', () => {
  it('resetting the loose-files course keeps progress for the courses in its subfolders', async () => {
    for (const filePath of [videoPath, looseVideoPath]) {
      expect((await postJson('/api/progress', { filePath, completed: true })).status).toBe(200);
    }

    const courseId = Buffer.from(libraryDir).toString('base64url');
    const reset = await (await postJson('/api/courses/reset', { courseId })).json();
    expect(reset.removedCount).toBe(1);

    const progress = await (await fetch(`${baseUrl}/api/progress`)).json();
    expect(progress[videoPath]).toBeDefined();
    expect(progress[looseVideoPath]).toBeUndefined();
  });
});
