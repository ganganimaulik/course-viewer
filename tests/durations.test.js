const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Lesson lengths on a Mac without ffprobe. The server runs as its own process here, with a PATH that holds no
// programs: Jest gives tests a copy of process.env, so changing PATH in this file wouldn't reach ffprobe.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-viewer-durations-'));
const libraryDir = path.join(tmpDir, 'library');
const courseDir = path.join(libraryDir, 'Course');

let server;
let baseUrl;

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  }).on('error', reject);
});

beforeAll(async () => {
  fs.mkdirSync(courseDir, { recursive: true });
  for (const name of ['a.mp4', 'b.mp4', 'c.mp3']) {
    fs.writeFileSync(path.join(courseDir, name), Buffer.alloc(100, 7));
  }
  const dbFile = path.join(tmpDir, 'db.json');
  fs.writeFileSync(dbFile, JSON.stringify({ folders: [libraryDir], progress: {}, aiConfig: { llmModel: '' } }));

  const port = await freePort();
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      HOME: os.homedir(),
      PATH: path.join(tmpDir, 'no-programs'),
      PORT: String(port),
      COURSE_VIEWER_DB: dbFile,
      COURSE_VIEWER_CACHE: path.join(tmpDir, 'cache'),
      FIREWORKS_API_KEY: '' // Keeps the .env file's key out of this process
    },
    stdio: 'ignore'
  });
  baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${baseUrl}/api/config`);
      return;
    } catch (err) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('The server did not start');
});

afterAll(async () => {
  await new Promise((resolve) => {
    server.once('exit', resolve);
    server.kill();
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

it('reports lengths it cannot measure as unknown, instead of as pending forever', async () => {
  const lengths = async () => (await (await fetch(`${baseUrl}/api/courses`)).json())[0].sections
    .flatMap((section) => section.items)
    .map((item) => item.duration);
  await lengths(); // Queues the files for ffprobe, which isn't there

  let measured;
  for (let i = 0; i < 50; i++) {
    measured = await (await fetch(`${baseUrl}/api/media/durations`)).json();
    if (measured.pending === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(measured.pending).toBe(0);
  expect(await lengths()).toEqual([null, null, null]);
});
