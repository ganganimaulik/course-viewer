const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// Load the server against a throwaway db.json and cache, so these tests can add a watched folder and save
// progress without touching the real ones. server.js creates the db file on load; stop here if it didn't.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-viewer-test-'));
const cacheDir = path.join(tmpDir, 'cache');
process.env.COURSE_VIEWER_DB = path.join(tmpDir, 'db.json');
process.env.COURSE_VIEWER_CACHE = cacheDir;
const { app } = require('../server');
if (!fs.existsSync(process.env.COURSE_VIEWER_DB)) {
  throw new Error('server.js ignored COURSE_VIEWER_DB; refusing to run against the real db.json');
}

const libraryDir = path.join(tmpDir, 'library');
const courseDir = path.join(libraryDir, 'Course A');
const videoPath = path.join(courseDir, 'lesson.mp4');
const pagePath = path.join(courseDir, 'page.html');
const audioPath = path.join(courseDir, 'talk.mp3');
const streamPath = path.join(courseDir, 'clip.ts');
const typescriptPath = path.join(courseDir, 'types.ts');
// Converting a transport stream needs ffmpeg and ffprobe; without them, that test is skipped
const hasFfmpeg = ['ffmpeg', 'ffprobe'].every((tool) => spawnSync(tool, ['-version']).status === 0);
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
  fs.writeFileSync(audioPath, Buffer.alloc(size, 7));
  fs.writeFileSync(typescriptPath, 'export const answer: number = 42;\n');
  if (hasFfmpeg) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=5',
      '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-f', 'mpegts', streamPath]);
  } else {
    // Enough of a transport stream (sync bytes every 188 bytes) to be recognised as one
    const packets = Buffer.alloc(188 * 3, 0xff);
    for (let i = 0; i < packets.length; i += 188) packets[i] = 0x47;
    fs.writeFileSync(streamPath, packets);
  }
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

describe('lesson types', () => {
  const courseItems = async () => {
    const courses = await (await fetch(`${baseUrl}/api/courses`)).json();
    const items = courses.find((c) => c.path === courseDir).sections.flatMap((s) => s.items);
    return Object.fromEntries(items.map((item) => [item.name, item]));
  };

  it('tells transport stream videos apart from TypeScript, and lists audio as lessons', async () => {
    const items = await courseItems();
    expect(items['talk.mp3'].type).toBe('audio');
    expect(items['clip.ts']).toMatchObject({ type: 'video', remux: true });
    expect(items['types.ts'].type).toBe('code');
  });

  it('streams audio with its own content type', async () => {
    const res = await fetch(`${baseUrl}/api/video?path=${encodeURIComponent(audioPath)}`, { headers: { Range: 'bytes=0-9' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect((await res.arrayBuffer()).byteLength).toBe(10);
  });

  (hasFfmpeg ? it : it.skip)('plays a transport stream from an MP4 copy that is made once', async () => {
    const url = `${baseUrl}/api/video?path=${encodeURIComponent(streamPath)}`;
    const first = await fetch(url, { headers: { Range: 'bytes=0-' } });
    expect(first.status).toBe(206);
    expect(first.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await first.arrayBuffer()).subarray(4, 8).toString()).toBe('ftyp');

    const again = await fetch(url, { headers: { Range: 'bytes=0-99' } });
    expect(again.status).toBe(206);
    await again.arrayBuffer();
    const copies = fs.readdirSync(path.join(cacheDir, 'playable')).filter((name) => name.endsWith('.mp4'));
    expect(copies).toHaveLength(1);
  });

  it('refuses to stream files that are not audio or video', async () => {
    const res = await fetch(`${baseUrl}/api/video?path=${encodeURIComponent(typescriptPath)}`);
    expect(res.status).toBe(403);
  });

  it('converts only Word documents through the docx endpoint', async () => {
    const res = await fetch(`${baseUrl}/api/docx?path=${encodeURIComponent(audioPath)}`);
    expect(res.status).toBe(403);
  });
});

describe('reading progress', () => {
  it('records how far a page is scrolled and completes it near the bottom', async () => {
    let prog = await (await postJson('/api/progress', { filePath: pagePath, scroll: 0.5 })).json();
    expect(prog).toMatchObject({ scroll: 0.5, percent: 50 });
    expect(prog.completed).toBeFalsy();

    prog = await (await postJson('/api/progress', { filePath: pagePath, scroll: 0.97 })).json();
    expect(prog).toMatchObject({ percent: 97, completed: true });
  });

  it('records the open page of a PDF and completes it on the last page', async () => {
    const pdfPath = path.join(courseDir, 'slides.pdf');
    let prog = await (await postJson('/api/progress', { filePath: pdfPath, page: 3, pages: 10 })).json();
    expect(prog).toMatchObject({ page: 3, pages: 10, percent: 30 });
    expect(prog.completed).toBeFalsy();

    prog = await (await postJson('/api/progress', { filePath: pdfPath, page: 10, pages: 10 })).json();
    expect(prog).toMatchObject({ percent: 100, completed: true });
  });

  it('keeps reading positions in range', async () => {
    const prog = await (await postJson('/api/progress', { filePath: path.join(courseDir, 'other.pdf'), page: 99, pages: 4 })).json();
    expect(prog).toMatchObject({ page: 4, pages: 4 });
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
