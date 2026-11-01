const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const mammoth = require('mammoth');
const { ModalClient, NotFoundError, TimeoutError } = require('modal');
const { PDFParse } = require('pdf-parse');

const execFileAsync = promisify(execFile);

async function pdfParse(dataBuffer) {
  const parser = new PDFParse({ data: dataBuffer });
  const result = await parser.getText();
  return result;
}

const app = express();
const PORT = process.env.PORT || 3005;
// Loopback only: the API reads files and starts paid AI jobs, so other machines must not reach it
const HOST = '127.0.0.1';
// COURSE_VIEWER_DB lets tests use a throwaway database
const DB_FILE = process.env.COURSE_VIEWER_DB || path.join(__dirname, 'db.json');
// Regenerable data, like browser-playable copies of videos, lives outside the course folders.
// COURSE_VIEWER_CACHE lets tests use a throwaway cache.
const CACHE_DIR = process.env.COURSE_VIEWER_CACHE || path.join(os.homedir(), 'Library', 'Caches', 'course-viewer');
const ENV_FILE = path.join(__dirname, '.env');

// Load API credentials (FIREWORKS_API_KEY, optional MODAL_TOKEN_ID / MODAL_TOKEN_SECRET) from .env
if (fs.existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

// AI services: Fireworks AI for LLM calls, a Whisper app deployed on Modal for transcription
const FIREWORKS_API_URL = 'https://api.fireworks.ai/inference/v1/chat/completions';
const DEFAULT_LLM_MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash-1017';
const FIREWORKS_KEY_MISSING = 'FIREWORKS_API_KEY is not set. Add it to the .env file and restart the server.';
const MODAL_APP_NAME = 'course-viewer-transcriber';
const MODAL_CLASS_NAME = 'Transcriber';
// Max wait for a Modal transcription, including any time spent queued for a GPU
const MODAL_TRANSCRIBE_TIMEOUT_MS = 30 * 60 * 1000;

const IGNORE_DIRS = ['node_modules', 'dist', 'build', '.git', 'venv', '.env', 'env', 'bower_components'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif'];
const CODE_EXTENSIONS = ['.js', '.ts', '.tsx', '.py', '.sh', '.json', '.css', '.go', '.rs', '.java', '.cpp', '.c', '.h', '.yaml', '.yml', '.xml', '.sql', '.ini', '.conf'];
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.mov', '.webm', '.avi'];
// MPEG transport streams (e.g. HLS downloads) play once copied into an MP4. ".ts" can also be TypeScript.
const TRANSPORT_STREAM_EXTENSIONS = ['.ts', '.m2ts', '.mts'];
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac'];
const MEDIA_CONTENT_TYPES = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.flac': 'audio/flac'
};
// Types listed under Lessons (everything else is a resource), matching LESSON_TYPES in public/app.js
const LESSON_TYPES = ['video', 'audio', 'pdf', 'html', 'docx', 'text'];
// Downloaded pages load on the app's own origin, where a script could call the API like the app does
// (e.g. watch the home folder, then read files from it). Block their scripts and form posts; embedded
// players such as Vimeo run in their own frames, which this policy doesn't reach.
const LESSON_PAGE_POLICY = "script-src 'none'; form-action 'none'";
// Converted copies of transport streams; the least recently watched are deleted past the size limit
const PLAYABLE_DIR = path.join(CACHE_DIR, 'playable');
const PLAYABLE_CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024;

// Only this machine's own pages may use the API. There are no CORS headers, so other sites can't read
// responses; on top of that:
// - the Host must be local, or a DNS-rebinding page on another domain could pass as same-origin
// - changes must come from the app's origin: a cross-site form or no-cors POST still reaches a local
//   server (it just can't read the reply), e.g. to wipe all progress
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1'];
app.use((req, res, next) => {
  if (!LOCAL_HOSTNAMES.includes(req.hostname)) {
    return res.status(403).send('Forbidden host');
  }
  const origin = req.headers.origin;
  if (origin && !['GET', 'HEAD'].includes(req.method) && origin !== `${req.protocol}://${req.headers.host}`) {
    return res.status(403).send('Cross-site request blocked');
  }
  next();
});
// Course summary file lists and long chat histories easily exceed the default 100kb body limit
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Database
let db = {
  folders: [
    '/Users/maulik/Downloads/courses',
    '/Users/maulik/Downloads/Mega Downloads'
  ],
  progress: {},
  aiConfig: {
    llmModel: ''
  }
};

if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    db = JSON.parse(raw);
    // Ensure aiConfig exists and drop the legacy Google Cloud settings
    if (!db.aiConfig || db.gcpConfig) {
      db.aiConfig = db.aiConfig || { llmModel: '' };
      delete db.gcpConfig;
      saveDb();
    }
  } catch (err) {
    console.error('Error reading db.json, creating new one', err);
    // Keep a copy of the unreadable file, since the next save replaces it
    const backupFile = `${DB_FILE}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(DB_FILE, backupFile);
      console.error(`Saved a copy of the unreadable db.json to ${backupFile}`);
    } catch (copyErr) {
      console.error('Error backing up db.json', copyErr);
    }
  }
} else {
  saveDb();
}

function saveDb() {
  try {
    // Write a temp file and rename it over db.json, so a crash mid-write can't leave a truncated file
    const tmpFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmpFile, DB_FILE);
  } catch (err) {
    console.error('Error saving db.json', err);
  }
}

// The "Downloads - <folder>" course is a watched folder itself: it holds only the folder's top-level files,
// while the folder's other courses sit in its subfolders
function isLooseFilesCourse(coursePath) {
  return (db.folders || []).includes(coursePath);
}

// The API only reads, streams, or opens paths inside the watched folders. Symlinks and ".." are resolved
// first, so neither can point a request at files elsewhere on disk.
function isInWatchedFolder(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return false;
  let realPath;
  try {
    realPath = fs.realpathSync(filePath);
  } catch (err) {
    return false; // Missing paths can't be served anyway
  }
  return (db.folders || []).some((folder) => {
    try {
      const root = fs.realpathSync(folder);
      return realPath === root || realPath.startsWith(root + path.sep);
    } catch (err) {
      return false; // The watched folder itself is missing (e.g. an unplugged drive)
    }
  });
}

const OUTSIDE_WATCHED_FOLDERS = 'Path is outside the watched folders';

// Stat a path, returning null unless it is a regular file (missing paths and directories can't be streamed)
function statFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat : null;
  } catch (err) {
    return null;
  }
}

// Pipe a file to the response. Read errors need a handler: an unhandled stream 'error' event crashes the server.
function pipeFile(res, filePath, options) {
  const stream = fs.createReadStream(filePath, options);
  stream.on('error', (err) => {
    console.error(`Error streaming ${filePath}:`, err);
    if (res.headersSent) {
      res.destroy(err);
    } else {
      res.status(500).send('Error reading file');
    }
  });
  stream.pipe(res);
}

// A transport stream repeats the 0x47 sync byte every 188 bytes (every 192 in .m2ts, after a 4-byte timestamp),
// which TypeScript source never does
function isTransportStream(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(200);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    return (bytesRead > 188 && header[0] === 0x47 && header[188] === 0x47) ||
      (bytesRead > 196 && header[4] === 0x47 && header[196] === 0x47);
  } catch (err) {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Lesson type of a file: video, audio, pdf, html, docx, text, image, code or other
function getFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (TRANSPORT_STREAM_EXTENSIONS.includes(ext) && isTransportStream(filePath)) return 'video';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.docx') return 'docx';
  if (ext === '.txt' || ext === '.md') return 'text';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (CODE_EXTENSIONS.includes(ext)) return 'code';
  return 'other'; // zips, slides, spreadsheets, etc.
}

function isMediaType(type) {
  return type === 'video' || type === 'audio';
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --- LESSON LENGTHS ---
// Video and audio lengths, measured with ffprobe in the background and kept between runs, so course cards can
// show total and remaining time before anything is played: { [path]: { size, mtimeMs, duration } }
const DURATIONS_FILE = path.join(CACHE_DIR, 'durations.json');
let mediaDurations = {};
try {
  mediaDurations = JSON.parse(fs.readFileSync(DURATIONS_FILE, 'utf8'));
} catch (err) {
  // Nothing measured yet
}
const durationQueue = new Set();
let measuringDurations = false;
let ffprobeMissing = false;

// Seconds; null if ffprobe couldn't read the file; undefined (left out of the JSON) while still being measured
function getMediaDuration(filePath, stat) {
  const known = mediaDurations[filePath];
  if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) {
    return known.duration;
  }
  if (!ffprobeMissing) {
    durationQueue.add(filePath);
    measureDurations();
  }
  return undefined;
}

function saveDurations() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmpFile = `${DURATIONS_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(mediaDurations), 'utf8');
    fs.renameSync(tmpFile, DURATIONS_FILE);
  } catch (err) {
    console.error('Error saving lesson lengths:', err);
  }
}

async function measureDurations() {
  if (measuringDurations) return;
  measuringDurations = true;
  let measured = 0;
  // A few at a time: each ffprobe call mostly waits on the disk
  const worker = async () => {
    while (durationQueue.size > 0 && !ffprobeMissing) {
      const filePath = durationQueue.values().next().value;
      durationQueue.delete(filePath);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (err) {
        continue; // Deleted since it was queued
      }
      let duration = null;
      try {
        const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
        const seconds = parseFloat(stdout);
        if (Number.isFinite(seconds)) duration = Math.round(seconds * 10) / 10;
      } catch (err) {
        if (err.code === 'ENOENT') {
          ffprobeMissing = true;
          console.warn('[ffprobe] Not found: lesson lengths will only be known once each lesson has played.');
          break;
        }
        // Unreadable file: recorded below, so it isn't measured again on every scan
      }
      mediaDurations[filePath] = { size: stat.size, mtimeMs: stat.mtimeMs, duration };
      if (++measured % 50 === 0) saveDurations();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  saveDurations();
  measuringDurations = false;
  if (durationQueue.size > 0 && !ffprobeMissing) {
    measureDurations(); // Queued while the last files were being measured
  }
}

// Convert SRT Subtitles to VTT on the fly
function convertSrtToVtt(srtContent) {
  return 'WEBVTT\n\n' + srtContent
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

// Traverse a folder and structure items into sections
function processCourseTree(courseName, coursePath, sourceRoot) {
  const sectionsMap = {};
  const allSubtitles = {};
  const mediaItems = [];

  function traverse(currentPath, currentSectionName = 'General') {
    try {
      if (!fs.existsSync(currentPath)) return;
      const items = fs.readdirSync(currentPath, { withFileTypes: true });

      // Natural alphanumeric sort
      items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

      // First pass: collect subtitle paths
      for (const item of items) {
        if (item.name.startsWith('.')) continue;
        const fullPath = path.join(currentPath, item.name);
        if (item.isFile()) {
          const ext = path.extname(item.name).toLowerCase();
          if (ext === '.vtt' || ext === '.srt') {
            const base = path.basename(item.name, ext);
            allSubtitles[path.join(currentPath, base)] = fullPath;
          }
        }
      }

      // Second pass: process folders and files
      for (const item of items) {
        if (item.name.startsWith('.')) continue;
        const fullPath = path.join(currentPath, item.name);

        if (item.isDirectory()) {
          if (IGNORE_DIRS.includes(item.name.toLowerCase())) {
            continue; // Skip ignored directories
          }
          const newSectionName = currentSectionName === 'General' ? item.name : `${currentSectionName} / ${item.name}`;
          traverse(fullPath, newSectionName);
        } else if (item.isFile()) {
          if (item.name.endsWith('.transcript.txt') || item.name.endsWith('.summary.md')) {
            continue;
          }
          const ext = path.extname(item.name).toLowerCase();
          if (ext === '.vtt' || ext === '.srt') {
            continue; // Skip files that are not main learning materials
          }
          const type = getFileType(fullPath);

          if (!sectionsMap[currentSectionName]) {
            sectionsMap[currentSectionName] = [];
          }

          const stat = fs.statSync(fullPath);
          const itemObj = {
            name: item.name,
            path: fullPath,
            relativePath: path.relative(coursePath, fullPath),
            type: type,
            extension: ext,
            size: stat.size
          };

          if (type === 'video' && TRANSPORT_STREAM_EXTENSIONS.includes(ext)) {
            itemObj.remux = true; // Played from a converted copy, made on first play
          }
          if (isMediaType(type)) {
            itemObj.duration = getMediaDuration(fullPath, stat);
            mediaItems.push(itemObj);
          }

          sectionsMap[currentSectionName].push(itemObj);
        }
      }
    } catch (err) {
      console.error(`Error traversing path ${currentPath}:`, err);
    }
  }

  traverse(coursePath);

  // Link subtitle tracks
  for (const media of mediaItems) {
    const mediaPathWithoutExt = media.path.slice(0, -path.extname(media.path).length);
    if (allSubtitles[mediaPathWithoutExt]) {
      media.subtitlePath = allSubtitles[mediaPathWithoutExt];
    }
  }

  const sections = Object.keys(sectionsMap).map(name => ({
    name: name,
    items: sectionsMap[name]
  }));

  // Reorder sections so General/Introduction matches top, followed by sections in alphanumeric order
  sections.sort((a, b) => {
    if (a.name === 'General') return -1;
    if (b.name === 'General') return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  return {
    id: Buffer.from(coursePath).toString('base64url'),
    title: courseName,
    path: coursePath,
    sourceRoot: sourceRoot,
    sections: sections
  };
}

// Scan all course folders
function scanAllCourses() {
  const courses = [];
  const folders = db.folders || [];
  for (const watchedFolder of folders) {
    try {
      if (!fs.existsSync(watchedFolder)) continue;
      const items = fs.readdirSync(watchedFolder, { withFileTypes: true });

      let looseFiles = [];
      for (const item of items) {
        if (item.name.startsWith('.')) continue;
        const fullPath = path.join(watchedFolder, item.name);

        if (item.isDirectory()) {
          const course = processCourseTree(item.name, fullPath, watchedFolder);
          const hasItems = course.sections.some(sec => sec.items.length > 0);
          if (hasItems) {
            courses.push(course);
          }
        } else if (item.isFile()) {
          if (LESSON_TYPES.includes(getFileType(fullPath))) {
            looseFiles.push(item.name);
          }
        }
      }

      if (looseFiles.length > 0) {
        const virtualCourseName = `Downloads - ${path.basename(watchedFolder)}`;
        const course = processCourseTree(virtualCourseName, watchedFolder, watchedFolder);
        // Only keep files at the top level to avoid duplicating folder contents
        course.sections = course.sections.filter(sec => sec.name === 'General');
        if (course.sections.length > 0 && course.sections[0].items.length > 0) {
          courses.push(course);
        }
      }
    } catch (err) {
      console.error(`Error scanning folder ${watchedFolder}:`, err);
    }
  }
  return courses;
}

// --- API ENDPOINTS ---

// Get watched folders list
app.get('/api/config', (req, res) => {
  res.send({ folders: db.folders });
});

// Add a watched folder
app.post('/api/config', (req, res) => {
  const folderPath = req.body.path;
  if (!folderPath) {
    return res.status(400).send({ error: 'Path is required' });
  }
  if (!fs.existsSync(folderPath)) {
    return res.status(400).send({ error: 'Folder path does not exist on disk' });
  }
  const stat = fs.statSync(folderPath);
  if (!stat.isDirectory()) {
    return res.status(400).send({ error: 'Path is a file, not a directory' });
  }

  const normalized = path.resolve(folderPath);
  if (!db.folders.includes(normalized)) {
    db.folders.push(normalized);
    saveDb();
  }
  res.send({ folders: db.folders });
});

// Remove a watched folder
app.post('/api/config/remove', (req, res) => {
  const folderPath = req.body.path;
  if (!folderPath) {
    return res.status(400).send({ error: 'Path is required' });
  }
  db.folders = db.folders.filter(f => f !== folderPath);
  saveDb();
  res.send({ folders: db.folders });
});

// Get all courses with progress and metadata merged
app.get('/api/courses', (req, res) => {
  const courses = scanAllCourses();

  for (const course of courses) {
    let totalItems = 0;
    let completedItems = 0;
    let courseLastStudied = null;
    let hasProgress = false;

    for (const section of course.sections) {
      for (const item of section.items) {
        totalItems++;
        const prog = db.progress[item.path];
        if (prog) {
          item.progress = prog;
          if (prog.completed || prog.skipped) {
            completedItems++;
          }
          if (prog.lastStudied) {
            hasProgress = true;
            if (!courseLastStudied || new Date(prog.lastStudied) > new Date(courseLastStudied)) {
              courseLastStudied = prog.lastStudied;
            }
          }
        } else {
          item.progress = null;
        }
      }
    }

    course.totalItems = totalItems;
    course.completedItems = completedItems;
    course.progressPercent = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;
    course.lastStudied = courseLastStudied;
    course.hasProgress = hasProgress;
  }

  // Sort courses: recently studied first, then alphabetical
  courses.sort((a, b) => {
    if (a.lastStudied && b.lastStudied) {
      return new Date(b.lastStudied) - new Date(a.lastStudied);
    }
    if (a.lastStudied) return -1;
    if (b.lastStudied) return 1;
    return a.title.localeCompare(b.title);
  });

  res.send(courses);
});

// Lengths measured so far, which the app fills in while ffprobe works through a new library
app.get('/api/media/durations', (req, res) => {
  const durations = {};
  for (const [filePath, info] of Object.entries(mediaDurations)) {
    if (info.duration) durations[filePath] = info.duration;
  }
  res.send({ durations, pending: durationQueue.size + (measuringDurations ? 1 : 0) });
});

// --- STUDY TIME ---
// Real time spent studying, which the app reports while a lesson plays or is being read:
// db.activity = { 'YYYY-MM-DD': { [coursePath]: seconds } }. Progress resets leave it alone.
const DEFAULT_WEEKLY_GOAL_HOURS = 5;
// The app reports at least once a minute, so a longer report is a bug or a forged request
const MAX_ACTIVITY_SECONDS = 300;

// Local calendar date; the server runs on this Mac, so its time zone is the user's
function localDateKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The course a file belongs to: its top-level folder in a watched folder, or the watched folder itself for
// loose files (the "Downloads - <folder>" course)
function getCoursePathForFile(filePath) {
  for (const folder of db.folders || []) {
    if (filePath.startsWith(folder + path.sep)) {
      const [first, ...rest] = path.relative(folder, filePath).split(path.sep);
      return rest.length > 0 ? path.join(folder, first) : folder;
    }
  }
  return null;
}

app.post('/api/activity', (req, res) => {
  const { filePath, seconds } = req.body;
  const amount = Number(seconds);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_ACTIVITY_SECONDS) {
    return res.status(400).send({ error: `seconds must be between 0 and ${MAX_ACTIVITY_SECONDS}` });
  }
  const coursePath = typeof filePath === 'string' && isInWatchedFolder(filePath) ? getCoursePathForFile(filePath) : null;
  if (!coursePath) {
    return res.status(400).send({ error: 'Invalid file path' });
  }

  db.activity = db.activity || {};
  const day = localDateKey();
  const perCourse = db.activity[day] = db.activity[day] || {};
  perCourse[coursePath] = Math.round(((perCourse[coursePath] || 0) + amount) * 10) / 10;
  saveDb();
  res.send({ success: true });
});

// Study time per day and per course (by course id), and the weekly goal
app.get('/api/activity', (req, res) => {
  const days = {};
  const courses = {};
  for (const [day, perCourse] of Object.entries(db.activity || {})) {
    for (const [coursePath, seconds] of Object.entries(perCourse)) {
      days[day] = (days[day] || 0) + seconds;
      const courseId = Buffer.from(coursePath).toString('base64url');
      courses[courseId] = (courses[courseId] || 0) + seconds;
    }
  }
  res.send({ days, courses, weeklyGoalHours: db.weeklyGoalHours || DEFAULT_WEEKLY_GOAL_HOURS });
});

app.post('/api/activity/goal', (req, res) => {
  const hours = Number(req.body.weeklyGoalHours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
    return res.status(400).send({ error: 'weeklyGoalHours must be between 0 and 168' });
  }
  db.weeklyGoalHours = Math.round(hours * 10) / 10;
  saveDb();
  res.send({ weeklyGoalHours: db.weeklyGoalHours });
});

// Get single item progress
app.get('/api/progress', (req, res) => {
  res.send(db.progress);
});

// Save progress for an item
app.post('/api/progress', (req, res) => {
  const { filePath, currentTime, duration, completed, skipped, scroll, page, pages } = req.body;
  if (!filePath) {
    return res.status(400).send({ error: 'filePath is required' });
  }

  if (!db.progress[filePath]) {
    db.progress[filePath] = {};
  }

  const prog = db.progress[filePath];
  prog.lastStudied = new Date().toISOString();

  if (currentTime !== undefined) prog.currentTime = currentTime;
  if (duration !== undefined) prog.duration = duration;

  // Reading position: how far a page is scrolled (0-1), or which page of a PDF is open
  const readingMoved = scroll !== undefined || (page !== undefined && pages);
  if (scroll !== undefined) {
    prog.scroll = Math.min(1, Math.max(0, Number(scroll) || 0));
  }
  if (page !== undefined && pages) {
    prog.pages = Math.max(1, Math.round(Number(pages)) || 1);
    prog.page = Math.min(prog.pages, Math.max(1, Math.round(Number(page)) || 1));
  }

  if (skipped !== undefined) {
    prog.skipped = skipped;
    if (skipped) {
      prog.completed = false;
      prog.percent = 100;
    } else {
      if (prog.duration && prog.currentTime !== undefined) {
        prog.percent = Math.min(100, Math.round((prog.currentTime / prog.duration) * 100));
      } else {
        prog.percent = 0;
      }
    }
  }

  if (completed !== undefined) {
    prog.completed = completed;
    if (completed) {
      prog.skipped = false;
      prog.percent = 100;
      if (prog.duration && prog.currentTime === undefined) {
        prog.currentTime = prog.duration;
      }
    } else {
      if (prog.duration && prog.currentTime !== undefined) {
        prog.percent = Math.min(100, Math.round((prog.currentTime / prog.duration) * 100));
      } else {
        prog.percent = 0;
      }
    }
  }

  if (!prog.skipped && prog.duration && prog.currentTime !== undefined) {
    prog.percent = Math.min(100, Math.round((prog.currentTime / prog.duration) * 100));
    if (prog.percent >= 95) {
      prog.completed = true;
    }
  }

  // Reaching the bottom of a page, or the last page of a PDF, completes it
  if (!prog.skipped && readingMoved) {
    const fraction = prog.pages ? prog.page / prog.pages : (prog.scroll || 0);
    prog.percent = Math.min(100, Math.round(fraction * 100));
    if (prog.pages ? prog.page >= prog.pages : prog.scroll >= 0.95) {
      prog.completed = true;
    }
  }

  saveDb();
  res.send(prog);
});

// Reset all progress
app.post('/api/progress/reset', (req, res) => {
  db.progress = {};
  saveDb();
  res.send({ success: true });
});

// Reset progress for a specific course
app.post('/api/courses/reset', (req, res) => {
  const { courseId } = req.body;
  if (!courseId) {
    return res.status(400).send({ error: 'courseId is required' });
  }

  // Decode courseId to get the course path
  let coursePath;
  try {
    coursePath = Buffer.from(courseId, 'base64url').toString('utf8');
  } catch (err) {
    return res.status(400).send({ error: 'Invalid courseId' });
  }

  // Find all progress entries that are inside the course path
  // Since db.progress keys are absolute file paths, we check if key is identical or starts with coursePath + separator
  // (only direct children for a loose-files course, whose subfolders are other courses)
  const looseFiles = isLooseFilesCourse(coursePath);
  const keys = Object.keys(db.progress);
  let count = 0;
  for (const filePath of keys) {
    const isSame = filePath === coursePath;
    const isInside = looseFiles
      ? path.dirname(filePath) === coursePath
      : filePath.startsWith(coursePath + path.sep);
    if (isSame || isInside) {
      delete db.progress[filePath];
      count++;
    }
  }

  saveDb();
  res.send({ success: true, removedCount: count });
});

// Mark all progress as completed for a specific course
app.post('/api/courses/complete', (req, res) => {
  const { courseId } = req.body;
  if (!courseId) {
    return res.status(400).send({ error: 'courseId is required' });
  }

  // Decode courseId to get the course path
  let coursePath;
  try {
    coursePath = Buffer.from(courseId, 'base64url').toString('utf8');
  } catch (err) {
    return res.status(400).send({ error: 'Invalid courseId' });
  }

  // Find all scanned courses and matching course
  const courses = scanAllCourses();
  const course = courses.find(c => c.id === courseId);
  if (!course) {
    return res.status(404).send({ error: 'Course not found' });
  }

  let count = 0;
  const now = new Date().toISOString();
  for (const section of course.sections) {
    for (const item of section.items) {
      const filePath = item.path;
      if (!db.progress[filePath]) {
        db.progress[filePath] = {};
      }
      const prog = db.progress[filePath];
      prog.lastStudied = now;
      prog.completed = true;
      prog.skipped = false;
      prog.percent = 100;
      if (isMediaType(item.type)) {
        if (prog.duration) {
          prog.currentTime = prog.duration;
        }
      }
      count++;
    }
  }

  saveDb();
  res.send({ success: true, completedCount: count });
});


// Codec names of a file's first video and audio streams (ffprobe ships with ffmpeg)
async function probeCodecs(filePath) {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', filePath]);
  const streams = JSON.parse(stdout).streams || [];
  const codecOf = (type) => (streams.find((s) => s.codec_type === type) || {}).codec_name || null;
  return { video: codecOf('video'), audio: codecOf('audio') };
}

// Delete the least recently watched copies once the cache is over its size limit
function prunePlayableCache(keepPath) {
  try {
    const copies = fs.readdirSync(PLAYABLE_DIR)
      .filter((name) => name.endsWith('.mp4'))
      .map((name) => {
        const copyPath = path.join(PLAYABLE_DIR, name);
        const stat = fs.statSync(copyPath);
        return { copyPath, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = copies.reduce((sum, copy) => sum + copy.size, 0);
    for (const copy of copies) {
      if (total <= PLAYABLE_CACHE_MAX_BYTES) break;
      if (copy.copyPath === keepPath) continue;
      fs.unlinkSync(copy.copyPath);
      total -= copy.size;
    }
  } catch (err) {
    console.error('Error pruning converted video cache:', err);
  }
}

const activeConversions = new Map();

// Browsers can't play MPEG transport streams, so copy their streams into an MP4 on first play and serve that
// copy from then on. Only codecs browsers lack are re-encoded, which is slow; most HLS downloads just get copied.
async function getPlayableCopy(filePath, stat) {
  const key = crypto.createHash('sha1').update(`${filePath}:${stat.size}:${stat.mtimeMs}`).digest('hex');
  const copyPath = path.join(PLAYABLE_DIR, `${key}.mp4`);
  if (fs.existsSync(copyPath)) {
    const now = new Date();
    fs.utimesSync(copyPath, now, now); // Mark it recently watched, so pruning keeps it
    return copyPath;
  }
  if (activeConversions.has(copyPath)) {
    return activeConversions.get(copyPath);
  }

  const conversion = (async () => {
    const partPath = `${copyPath}.part`;
    try {
      fs.mkdirSync(PLAYABLE_DIR, { recursive: true });
      const codecs = await probeCodecs(filePath);
      const copyVideo = codecs.video === 'h264' || codecs.video === 'hevc';
      const args = [
        '-hide_banner', '-loglevel', 'error', '-i', filePath, '-map', '0:v:0?', '-map', '0:a:0?',
        '-c:v', copyVideo ? 'copy' : 'libx264', ...(copyVideo ? [] : ['-preset', 'veryfast']),
        ...(codecs.video === 'hevc' ? ['-tag:v', 'hvc1'] : []), // Safari and Chrome on macOS expect this tag
        '-c:a', codecs.audio === 'aac' ? 'copy' : 'aac', '-movflags', '+faststart', '-f', 'mp4', '-y', partPath
      ];
      console.log(`[FFmpeg] Converting ${filePath} for playback (${copyVideo ? 'copying' : 're-encoding'} video)...`);
      await execFileAsync('ffmpeg', args);
      fs.renameSync(partPath, copyPath);
      prunePlayableCache(copyPath);
      return copyPath;
    } catch (err) {
      fs.rmSync(partPath, { force: true });
      throw err;
    }
  })();
  activeConversions.set(copyPath, conversion);
  try {
    return await conversion;
  } finally {
    activeConversions.delete(copyPath);
  }
}

// Video and audio streaming endpoint with range request support
app.get('/api/video', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) {
    return res.status(400).send('Path is required');
  }
  let stat = statFile(filePath);
  if (!stat) {
    return res.status(404).send('File not found');
  }
  if (!isInWatchedFolder(filePath)) {
    return res.status(403).send(OUTSIDE_WATCHED_FOLDERS);
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!isMediaType(getFileType(filePath))) {
    return res.status(403).send('Forbidden file type');
  }

  let streamPath = filePath;
  let contentType = MEDIA_CONTENT_TYPES[ext];
  if (TRANSPORT_STREAM_EXTENSIONS.includes(ext)) {
    try {
      streamPath = await getPlayableCopy(filePath, stat);
    } catch (err) {
      console.error(`Error converting ${filePath} for playback:`, err);
      return res.status(500).send('Could not convert this video for the browser');
    }
    stat = fs.statSync(streamPath);
    contentType = 'video/mp4';
  }

  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    let start = parseInt(parts[0], 10);
    // Clamp the end to the file, since clients may ask for more bytes than it has
    let end = parts[1] ? Math.min(parseInt(parts[1], 10), fileSize - 1) : fileSize - 1;
    if (isNaN(start) && parts[1]) {
      // Suffix range: "bytes=-500" asks for the last 500 bytes
      start = Math.max(0, fileSize - parseInt(parts[1], 10));
      end = fileSize - 1;
    }

    if (isNaN(start) || isNaN(end) || start >= fileSize || start > end) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).send('Requested range not satisfiable');
      return;
    }

    const chunksize = (end - start) + 1;
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
    };

    res.writeHead(206, head);
    pipeFile(res, streamPath, { start, end });
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': contentType,
    };
    res.writeHead(200, head);
    pipeFile(res, streamPath);
  }
});

// Subtitles stream
app.get('/api/subtitle', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) {
    return res.status(400).send('Path is required');
  }
  if (!statFile(filePath)) {
    return res.status(404).send('File not found');
  }
  if (!isInWatchedFolder(filePath)) {
    return res.status(403).send(OUTSIDE_WATCHED_FOLDERS);
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.vtt') {
    res.setHeader('Content-Type', 'text/vtt');
    pipeFile(res, filePath);
  } else if (ext === '.srt') {
    try {
      const srtContent = fs.readFileSync(filePath, 'utf8');
      const vttContent = convertSrtToVtt(srtContent);
      res.setHeader('Content-Type', 'text/vtt');
      res.send(vttContent);
    } catch (err) {
      console.error(err);
      res.status(500).send('Error reading subtitle');
    }
  } else {
    res.status(400).send('Unsupported subtitle extension');
  }
});

// Serves PDF, HTML, images, code, or plain text
app.get('/api/file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) {
    return res.status(400).send('Path is required');
  }
  if (!statFile(filePath)) {
    return res.status(404).send('File not found');
  }
  if (!isInWatchedFolder(filePath)) {
    return res.status(403).send(OUTSIDE_WATCHED_FOLDERS);
  }

  const ext = path.extname(filePath).toLowerCase();
  let contentType = 'application/octet-stream';

  const textExtensions = ['.txt', '.md', ...CODE_EXTENSIONS];

  if (ext === '.pdf') {
    contentType = 'application/pdf';
  } else if (ext === '.html' || ext === '.htm') {
    contentType = 'text/html';
    res.setHeader('Content-Security-Policy', LESSON_PAGE_POLICY);
  } else if (textExtensions.includes(ext)) {
    contentType = 'text/plain';
  } else if (ext === '.png') {
    contentType = 'image/png';
  } else if (['.jpg', '.jpeg'].includes(ext)) {
    contentType = 'image/jpeg';
  } else if (ext === '.gif') {
    contentType = 'image/gif';
  }

  res.setHeader('Content-Type', contentType);
  pipeFile(res, filePath);
});

// Word documents, converted to a plain page and shown in the lesson frame like downloaded HTML
app.get('/api/docx', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) {
    return res.status(400).send('Path is required');
  }
  if (!statFile(filePath)) {
    return res.status(404).send('File not found');
  }
  if (!isInWatchedFolder(filePath)) {
    return res.status(403).send(OUTSIDE_WATCHED_FOLDERS);
  }
  if (getFileType(filePath) !== 'docx') {
    return res.status(403).send('Forbidden file type');
  }

  try {
    // Mammoth escapes the document's text; links and images stay inert under the lesson page policy
    const { value: body } = await mammoth.convertToHtml({ path: filePath });
    res.setHeader('Content-Security-Policy', LESSON_PAGE_POLICY);
    res.type('html').send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(path.basename(filePath))}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; max-width: 820px; margin: 0 auto; padding: 40px 32px 80px; line-height: 1.65; color: #1f2937; background: #fff; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; margin: 16px 0; }
  td, th { border: 1px solid #d1d5db; padding: 6px 10px; vertical-align: top; }
  a { color: #6d28d9; }
</style>
</head>
<body>${body}</body>
</html>`);
  } catch (err) {
    console.error(`Error converting ${filePath}:`, err);
    res.status(500).send('Could not read this Word document');
  }
});

// Reveal file in Mac Finder
app.post('/api/open-in-finder', (req, res) => {
  const filePath = req.body.path;
  if (!filePath || !fs.existsSync(filePath) || !isInWatchedFolder(filePath)) {
    return res.status(400).send('Invalid path');
  }

  // execFile passes the path as one argument, so no shell expands characters like $ or ` in file names
  execFile('open', ['-R', filePath], (err) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Failed to open in Finder');
    }
    res.send({ success: true });
  });
});

// Open file with default application on Mac
app.post('/api/open-in-system', (req, res) => {
  const filePath = req.body.path;
  if (!filePath || !fs.existsSync(filePath) || !isInWatchedFolder(filePath)) {
    return res.status(400).send('Invalid path');
  }

  execFile('open', [filePath], (err) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Failed to open file in default app');
    }
    res.send({ success: true });
  });
});

// --- AI CONFIG ENDPOINTS ---

// Fireworks AI is configured when its API key is present in the environment (or .env)
function isLlmConfigured() {
  return Boolean(process.env.FIREWORKS_API_KEY);
}

// Modal is configured when a token is set in the environment or in the Modal CLI config (~/.modal.toml)
function isTranscriptionConfigured() {
  if (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) return true;
  const configPath = process.env.MODAL_CONFIG_PATH || path.join(os.homedir(), '.modal.toml');
  try {
    return /^\s*token_id\s*=/m.test(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    return false;
  }
}

function getLlmModel() {
  return (db.aiConfig && db.aiConfig.llmModel) || DEFAULT_LLM_MODEL;
}

// Never include secrets here: this is sent to the browser
function getAiConfigStatus() {
  return {
    llmModel: getLlmModel(),
    defaultLlmModel: DEFAULT_LLM_MODEL,
    llmConfigured: isLlmConfigured(),
    transcriptionConfigured: isTranscriptionConfigured(),
    transcriptionApp: MODAL_APP_NAME
  };
}

app.get('/api/ai-config', (req, res) => {
  res.send(getAiConfigStatus());
});

app.post('/api/ai-config', (req, res) => {
  const { llmModel } = req.body;
  db.aiConfig = {
    llmModel: (llmModel || '').trim()
  };
  saveDb();
  res.send({ success: true, aiConfig: getAiConfigStatus() });
});

// --- VIDEO EXTRA METADATA ENDPOINTS ---

app.get('/api/video/metadata', (req, res) => {
  const videoPath = req.query.path;
  if (!videoPath || !fs.existsSync(videoPath) || !isInWatchedFolder(videoPath)) {
    return res.status(400).send('Invalid file path');
  }

  const ext = path.extname(videoPath);
  const baseWithoutExt = videoPath.slice(0, -ext.length);
  const transcriptPath = baseWithoutExt + '.transcript.txt';
  const summaryPath = baseWithoutExt + '.summary.md';

  let transcript = '';
  let hasTranscript = false;
  if (fs.existsSync(transcriptPath)) {
    try {
      const content = fs.readFileSync(transcriptPath, 'utf8');
      if (content.trim()) {
        transcript = content;
        hasTranscript = true;
      }
    } catch (err) {
      console.error('Error reading transcript file:', err);
    }
  }

  let summary = '';
  let hasSummary = false;
  if (fs.existsSync(summaryPath)) {
    try {
      const content = fs.readFileSync(summaryPath, 'utf8');
      if (content.trim()) {
        summary = content;
        hasSummary = true;
      }
    } catch (err) {
      console.error('Error reading summary file:', err);
    }
  }

  res.send({
    hasTranscript,
    hasSummary,
    transcript,
    summary
  });
});

// --- HELPERS FOR TRANSCRIPTION AND SUMMARIZATION ---

// Helper to parse and format timestamps from SRT/VTT (e.g. "00:12:35.450" -> "[12:35]")
function formatTimestamp(timeStr) {
  const cleaned = timeStr.split(/[.,]/)[0].trim();
  const parts = cleaned.split(':');
  if (parts.length === 3) {
    const h = parseInt(parts[0], 10);
    const m = parts[1];
    const s = parts[2];
    if (h === 0) {
      return `[${m}:${s}]`;
    } else {
      const hStr = h < 10 ? `0${h}` : `${h}`;
      return `[${hStr}:${m}:${s}]`;
    }
  } else if (parts.length === 2) {
    return `[${parts[0]}:${parts[1]}]`;
  }
  return `[${cleaned}]`;
}

// Clean subtitle track files (WebVTT/SRT) to plain text with timestamps embedded
function cleanSubtitleText(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const result = [];
  let currentTimestamp = '';
  let currentTextParts = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (!line) {
      // Empty line: push current cue and reset
      if (currentTimestamp && currentTextParts.length > 0) {
        const text = currentTextParts.join(' ').trim();
        if (text) {
          result.push(`${currentTimestamp} ${text}`);
        }
        currentTimestamp = '';
        currentTextParts = [];
      }
      continue;
    }
    
    // Check if it's the WEBVTT header
    if (line.toUpperCase().startsWith('WEBVTT')) continue;
    if (line.startsWith('NOTE ') || line === 'NOTE') continue;
    
    // Check if it's a timestamp line
    if (line.includes('-->')) {
      if (currentTimestamp && currentTextParts.length > 0) {
        const text = currentTextParts.join(' ').trim();
        if (text) {
          result.push(`${currentTimestamp} ${text}`);
        }
        currentTextParts = [];
      }
      const parts = line.split('-->');
      const startStr = parts[0].trim();
      currentTimestamp = formatTimestamp(startStr);
      continue;
    }
    
    // Skip sequence numbers
    if (/^\d+$/.test(line) && !currentTimestamp) {
      continue;
    }
    
    // Otherwise, add to text parts
    if (currentTimestamp) {
      currentTextParts.push(line);
    }
  }
  
  // Push any trailing cue
  if (currentTimestamp && currentTextParts.length > 0) {
    const text = currentTextParts.join(' ').trim();
    if (text) {
      result.push(`${currentTimestamp} ${text}`);
    }
  }
  
  return result.join(' ').replace(/\s+/g, ' ');
}

// Clean HTML text content by removing tags, script/style content, and unescaping common entities
function cleanHtmlText(html) {
  if (!html) return '';
  let clean = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  clean = clean.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  clean = clean.replace(/<\/p>|<\/div>|<br\s*\/?>|<\/h\d>/gi, '\n');
  clean = clean.replace(/<[^>]*>/g, '');
  clean = clean
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  return clean.replace(/\n\s*\n+/g, '\n\n').trim();
}

// Helper to resolve relative path of a video within a course
function getRelativePathFromAbsolute(videoPath) {
  const folders = db.folders || [];
  for (const folder of folders) {
    if (videoPath.startsWith(folder + path.sep) || videoPath.startsWith(folder)) {
      const relToWatch = path.relative(folder, videoPath);
      const segments = relToWatch.split(path.sep);
      if (segments.length > 1) {
        return segments.slice(1).join('/');
      }
    }
  }
  return path.basename(videoPath);
}

// Convert timestamp string like "12:35" or "01:12:35" to total seconds
function timestampToSeconds(timeStr) {
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

// Post-process summary to turn [MM:SS] timestamps into Markdown links
function insertTimestampLinks(summaryText, relativePath) {
  if (!relativePath) return summaryText;
  const regex = /\[(\d{1,2}:\d{2}(?::\d{2})?)\](?!\()/g;
  return summaryText.replace(regex, (match, timeStr) => {
    const seconds = timestampToSeconds(timeStr);
    const encodedPath = encodeURIComponent(relativePath);
    return `[${timeStr}](timestamp:${encodedPath}#${seconds})`;
  });
}

// Call a Fireworks AI chat model (OpenAI-compatible API) and return the reply text.
// The response is streamed so long generations aren't cut off by fetch's 5-minute headers timeout.
async function generateWithFireworks(messages, { maxTokens = 32768 } = {}) {
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) {
    throw new Error(FIREWORKS_KEY_MISSING);
  }
  const model = getLlmModel();

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(FIREWORKS_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: true })
      });

      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`Fireworks API error ${res.status}: ${body.slice(0, 500)}`);
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }

      // Parse server-sent events, keeping only the answer (reasoning arrives as delta.reasoning_content)
      const decoder = new TextDecoder();
      let buffer = '';
      let text = '';
      let finishReason = null;
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          const event = JSON.parse(data);
          if (event.error) {
            throw new Error(`Fireworks API error: ${event.error.message || JSON.stringify(event.error)}`);
          }
          const choice = event.choices && event.choices[0];
          if (!choice) continue;
          if (choice.delta && choice.delta.content) text += choice.delta.content;
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      }

      if (finishReason === 'length') {
        console.warn(`[Fireworks] Response from ${model} hit the ${maxTokens} token limit and may be truncated.`);
      }
      // Some models inline their reasoning in <think> tags instead of a separate field
      return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    } catch (err) {
      if (err.retryable === false || attempt === maxRetries) {
        throw err;
      }
      console.warn(`[Fireworks] Request attempt ${attempt}/${maxRetries} failed, retrying: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    }
  }
}

// Call Fireworks AI to generate summary from transcript or document notes
async function summarizeContent(content, type, relativePath = '') {
  const isTranscript = type === 'video' || type === 'transcript';
  console.log(`[Fireworks] Summarizing ${type} with ${getLlmModel()}...`);

  const prompt = isTranscript ? `
You are an AI assistant helping a student review course lecture material.
Below is the raw transcript of a lecture. Please perform the following:
1. Provide a concise, high-level summary of the main topics discussed (3-5 sentences).
2. Create a bulleted list of key takeaways, concepts, or terms explained in the lecture. If the transcript contains start timestamps like \`[MM:SS]\` or \`[HH:MM:SS]\` before segments, ensure every key takeaway or bullet point starts with the exact timestamp from the transcript where that topic is discussed. Format the timestamp exactly as it appears in the transcript, enclosed in square brackets, at the start of the bullet point (e.g. "- [12:35] key takeaway"). If there are no timestamps in the transcript, do not invent or add fake timestamps.
3. Formulate 2-3 review questions based on the content.

Format the output nicely in Markdown.

Here is the transcript:
---
${content}
---
` : `
You are an AI assistant helping a student review course lecture material.
Below is the content of a course document/notes file. Please perform the following:
1. Provide a concise, high-level summary of the main topics and concepts discussed in this document (3-5 sentences).
2. Create a bulleted list of key takeaways, definitions, code snippets, or formulas presented.
3. Formulate 2-3 review questions based on the content.

Format the output nicely in Markdown.

Here is the document content:
---
${content}
---
`;

  let summary = await generateWithFireworks([{ role: 'user', content: prompt }]);
  if (!summary) {
    throw new Error('Summarization returned empty text.');
  }

  // If this is a video transcript summary, post-process it to add links to the timestamps
  if (isTranscript && relativePath) {
    summary = insertTimestampLinks(summary, relativePath);
  }

  return summary;
}

// Helper to limit concurrency of async tasks
async function limitConcurrency(limit, array, fn) {
  const results = [];
  const executing = [];
  for (let i = 0; i < array.length; i++) {
    const p = Promise.resolve().then(() => fn(array[i], i));
    results.push(p);
    if (limit <= array.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
}

// Global Promise-based mutex to ensure FFmpeg is executed one at a time
let ffmpegMutex = Promise.resolve();

// Format seconds to [MM:SS] or [HH:MM:SS] timestamp
function formatSecondsToTimestamp(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  
  const mStr = m < 10 ? `0${m}` : `${m}`;
  const sStr = s < 10 ? `0${s}` : `${s}`;
  
  if (h === 0) {
    return `[${mStr}:${sStr}]`;
  } else {
    const hStr = h < 10 ? `0${h}` : `${h}`;
    return `[${hStr}:${mStr}:${sStr}]`;
  }
}

// Group Whisper segments into timestamped paragraphs ("[MM:SS] text"), breaking at a sentence end after ~30 seconds
function formatTranscriptSegments(segments, paragraphSeconds = 30) {
  const paragraphs = [];
  let current = null;
  for (const segment of segments || []) {
    const text = (segment.text || '').trim();
    if (!text) continue;
    if (!current) {
      current = { start: segment.start, texts: [] };
    }
    current.texts.push(text);
    const elapsed = segment.end - current.start;
    const endsSentence = /[.!?]["')\]]?$/.test(text);
    if ((elapsed >= paragraphSeconds && endsSentence) || elapsed >= paragraphSeconds * 2) {
      paragraphs.push(current);
      current = null;
    }
  }
  if (current) {
    paragraphs.push(current);
  }
  return paragraphs
    .map((p) => `${formatSecondsToTimestamp(p.start)} ${p.texts.join(' ')}`)
    .join('\n\n');
}

// WebVTT timestamp, e.g. 75.5 -> "00:01:15.500"
function formatVttTime(totalSeconds) {
  const ms = Math.round(Math.max(0, totalSeconds) * 1000);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

// WebVTT captions from Whisper's sentence segments. Long sentences are split into cues of about two lines,
// each timed by its share of the sentence's text.
function formatSegmentsAsVtt(segments, maxCueChars = 84) {
  const cues = [];
  for (const segment of segments || []) {
    const text = (segment.text || '').trim().replace(/\s+/g, ' ');
    if (!text) continue;

    const pieces = [];
    let current = '';
    for (const word of text.split(' ')) {
      if (current && current.length + 1 + word.length > maxCueChars) {
        pieces.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    pieces.push(current);

    const span = Math.max(0, segment.end - segment.start);
    let offset = 0;
    for (const piece of pieces) {
      const start = segment.start + span * (offset / text.length);
      offset += piece.length + 1;
      const end = segment.start + span * Math.min(1, offset / text.length);
      const cueText = piece.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      cues.push(`${formatVttTime(start)} --> ${formatVttTime(end)}\n${cueText}`);
    }
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

// Save captions next to the lesson, where the scanner attaches them like any subtitle file. Only called when
// the lesson had no subtitles, so nothing is overwritten.
function saveCaptions(mediaPath, captions) {
  const captionsPath = mediaPath.slice(0, -path.extname(mediaPath).length) + '.vtt';
  fs.writeFileSync(captionsPath, captions, 'utf8');
  return captionsPath;
}

let modalClient = null;

// Look up the transcribe method of the Transcriber class deployed on Modal (see modal_transcriber.py)
async function getModalTranscribeMethod() {
  if (!modalClient) {
    modalClient = new ModalClient();
  }
  try {
    const cls = await modalClient.cls.fromName(MODAL_APP_NAME, MODAL_CLASS_NAME);
    const instance = await cls.instance();
    return instance.method('transcribe');
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new Error(`Modal app "${MODAL_APP_NAME}" is not deployed. Run "npm run modal:deploy" first.`);
    }
    throw err;
  }
}

// Transcribe a video's audio track with Whisper running on a Modal GPU
async function transcribeVideoWithModal(videoPath) {
  const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const tempAudioPath = path.join(os.tmpdir(), `course-viewer-audio_${uniqueId}.ogg`);

  try {
    // 1. Extract a compact mono Opus audio track locally (one at a time)
    const currentLock = ffmpegMutex;
    let resolveLock;
    ffmpegMutex = new Promise((resolve) => { resolveLock = resolve; });
    await currentLock;

    try {
      console.log(`[FFmpeg] Extracting audio from ${videoPath}...`);
      await new Promise((resolve, reject) => {
        const args = ['-hide_banner', '-loglevel', 'error', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '32k', '-y', tempAudioPath];
        execFile('ffmpeg', args, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    } finally {
      resolveLock();
    }

    // 2. Transcribe on Modal, cancelling the call if it doesn't finish in time (e.g. stuck waiting for a GPU)
    const audio = fs.readFileSync(tempAudioPath);
    console.log(`[Modal] Transcribing ${(audio.length / (1024 * 1024)).toFixed(1)} MB of audio...`);
    const transcribe = await getModalTranscribeMethod();
    const call = await transcribe.spawn([new Uint8Array(audio.buffer, audio.byteOffset, audio.length)]);
    let result;
    try {
      result = await call.get({ timeoutMs: MODAL_TRANSCRIBE_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof TimeoutError) {
        await call.cancel().catch((cancelErr) => console.error('Error cancelling Modal transcription:', cancelErr));
        throw new Error(`Modal transcription timed out (${MODAL_TRANSCRIBE_TIMEOUT_MS / 60000} minutes)`);
      }
      throw err;
    }

    const transcript = formatTranscriptSegments(result.segments);
    if (!transcript) {
      throw new Error('Transcription returned empty text.');
    }
    console.log(`[Modal] Transcription completed (language: ${result.language}, ${Math.round(result.duration)}s of audio).`);
    return { transcript, captions: formatSegmentsAsVtt(result.segments) };
  } finally {
    // Clean up local temp file
    if (fs.existsSync(tempAudioPath)) {
      try {
        fs.unlinkSync(tempAudioPath);
      } catch (err) {
        console.error('Error deleting local temp audio file:', err);
      }
    }
  }
}

// Global state for active course summary background jobs
const activeJobs = {};

// Background processor job
// Background processor job
async function runCourseSummaryJob(courseId, coursePath, selectedFiles) {
  const job = activeJobs[courseId];
  if (!job) return;

  const logMessage = (msg) => {
    const timestamp = new Date().toLocaleTimeString();
    job.logs.push(`[${timestamp}] ${msg}`);
    job.progress = msg;
    console.log(`[Job ${courseId}] ${msg}`);
  };

  try {
    if (!isLlmConfigured()) {
      throw new Error(FIREWORKS_KEY_MISSING);
    }
    logMessage('Scanning course structure...');

    // Traverse the course path using processCourseTree
    const courseTree = processCourseTree(path.basename(coursePath), coursePath, null);
    const allItems = [];

    courseTree.sections.forEach(sec => {
      sec.items.forEach(item => {
        const isEligible = ['video', 'audio', 'text', 'html', 'pdf', 'docx'].includes(item.type);
        if (isEligible) {
          allItems.push({
            ...item,
            sectionName: sec.name
          });
        }
      });
    });

    logMessage(`Found ${allItems.length} eligible files in the course.`);

    let itemsToProcess = allItems;
    if (selectedFiles && Array.isArray(selectedFiles)) {
      itemsToProcess = allItems.filter(item => selectedFiles.includes(item.path));
    }

    logMessage(`Summarizing ${itemsToProcess.length} selected file(s)...`);

    if (itemsToProcess.length === 0) {
      throw new Error('No files selected or found to summarize.');
    }

    const summaries = new Array(itemsToProcess.length);
    const skippedFiles = [];
    let completedCount = 0;

    await limitConcurrency(10, itemsToProcess, async (item, index) => {
      const ext = path.extname(item.path);
      const baseWithoutExt = item.path.slice(0, -ext.length);
      const itemSummaryPath = baseWithoutExt + '.summary.md';

      logMessage(`[Start] Analyzing file: "${item.name}"...`);

      let hasNotes = false;
      let notesContent = '';

      if (fs.existsSync(itemSummaryPath)) {
        logMessage(`Found existing summary for "${item.name}".`);
        notesContent = fs.readFileSync(itemSummaryPath, 'utf8');
        hasNotes = true;
      } else {
        if (isMediaType(item.type)) {
          const videoTranscriptPath = baseWithoutExt + '.transcript.txt';
          let transcript = '';
          if (fs.existsSync(videoTranscriptPath)) {
            try {
              transcript = fs.readFileSync(videoTranscriptPath, 'utf8').trim();
            } catch (err) {
              logMessage(`[Error] Failed to read transcript for "${item.name}": ${err.message}`);
            }
          }

          if (transcript) {
            logMessage(`Found existing transcript for "${item.name}". Generating summary...`);
            try {
              const summary = await summarizeContent(transcript, 'video', item.relativePath);
              fs.writeFileSync(itemSummaryPath, summary, 'utf8');
              notesContent = summary;
              hasNotes = true;
            } catch (err) {
              logMessage(`[Error] Failed to generate summary from transcript for "${item.name}": ${err.message}`);
            }
          } else if (item.subtitlePath && fs.existsSync(item.subtitlePath)) {
            logMessage(`Found subtitle track for "${item.name}". Extracting transcript and generating notes...`);
            try {
              const subtitleContent = fs.readFileSync(item.subtitlePath, 'utf8');
              const cleanedText = cleanSubtitleText(subtitleContent);
              const summary = await summarizeContent(cleanedText, 'video', item.relativePath);
              
              fs.writeFileSync(videoTranscriptPath, cleanedText, 'utf8');
              fs.writeFileSync(itemSummaryPath, summary, 'utf8');
              
              notesContent = summary;
              hasNotes = true;
            } catch (err) {
              logMessage(`[Error] Failed to process subtitles for "${item.name}": ${err.message}`);
            }
          } else {
            // No subtitles/notes. Transcribe the audio on Modal if configured
            if (isTranscriptionConfigured()) {
              logMessage(`No notes or subtitles found for "${item.name}". Transcribing audio on Modal (this can take a moment)...`);
              try {
                const { transcript, captions } = await transcribeVideoWithModal(item.path);
                const summary = await summarizeContent(transcript, 'video', item.relativePath);

                fs.writeFileSync(videoTranscriptPath, transcript, 'utf8');
                saveCaptions(item.path, captions);
                fs.writeFileSync(itemSummaryPath, summary, 'utf8');
                
                notesContent = summary;
                hasNotes = true;
              } catch (err) {
                logMessage(`[Error] Transcription failed for "${item.name}": ${err.message}`);
              }
            } else {
              logMessage(`[Warning] Skipping "${item.name}" because it has no notes or subtitles, and Modal transcription is not configured.`);
              skippedFiles.push(item.name);
            }
          }
        } else if (item.type === 'text') {
          logMessage(`Reading Markdown content for "${item.name}" and generating notes...`);
          try {
            const content = fs.readFileSync(item.path, 'utf8');
            const trimmed = content.trim();
            const isUrl = /^(https?:\/\/[^\s]+)$/i.test(trimmed);
            if (trimmed && !isUrl) {
              const summary = await summarizeContent(content, 'document');
              fs.writeFileSync(itemSummaryPath, summary, 'utf8');
              notesContent = summary;
              hasNotes = true;
            } else if (isUrl) {
              logMessage(`[Warning] Skipping text file "${item.name}" because it only contains a URL.`);
              skippedFiles.push(item.name);
            } else {
              logMessage(`[Warning] Skipping empty text file "${item.name}".`);
            }
          } catch (err) {
            logMessage(`[Error] Failed to process text file "${item.name}": ${err.message}`);
          }
        } else if (item.type === 'html') {
          logMessage(`Reading HTML content for "${item.name}", cleaning markup, and generating notes...`);
          try {
            const htmlContent = fs.readFileSync(item.path, 'utf8');
            const cleanedText = cleanHtmlText(htmlContent);
            if (cleanedText.trim()) {
              const summary = await summarizeContent(cleanedText, 'document');
              fs.writeFileSync(itemSummaryPath, summary, 'utf8');
              notesContent = summary;
              hasNotes = true;
            } else {
              logMessage(`[Warning] Skipping empty HTML file "${item.name}".`);
            }
          } catch (err) {
            logMessage(`[Error] Failed to process HTML file "${item.name}": ${err.message}`);
          }
        } else if (item.type === 'pdf') {
          logMessage(`Reading PDF content for "${item.name}" and generating notes...`);
          try {
            const dataBuffer = fs.readFileSync(item.path);
            const pdfData = await pdfParse(dataBuffer);
            const text = pdfData.text || '';
            if (text.trim()) {
              const summary = await summarizeContent(text, 'document');
              fs.writeFileSync(itemSummaryPath, summary, 'utf8');

              // Save the extracted text to transcript.txt so users can chat with it
              const videoTranscriptPath = baseWithoutExt + '.transcript.txt';
              fs.writeFileSync(videoTranscriptPath, text, 'utf8');

              notesContent = summary;
              hasNotes = true;
            } else {
              logMessage(`[Warning] Skipping empty PDF file "${item.name}".`);
            }
          } catch (err) {
            logMessage(`[Error] Failed to process PDF file "${item.name}": ${err.message}`);
          }
        } else if (item.type === 'docx') {
          logMessage(`Reading Word document "${item.name}" and generating notes...`);
          try {
            const { value: text } = await mammoth.extractRawText({ path: item.path });
            if (text.trim()) {
              const summary = await summarizeContent(text, 'document');
              fs.writeFileSync(itemSummaryPath, summary, 'utf8');
              // Save the extracted text to transcript.txt so users can chat with it
              fs.writeFileSync(baseWithoutExt + '.transcript.txt', text, 'utf8');
              notesContent = summary;
              hasNotes = true;
            } else {
              logMessage(`[Warning] Skipping empty Word document "${item.name}".`);
            }
          } catch (err) {
            logMessage(`[Error] Failed to process Word document "${item.name}": ${err.message}`);
          }
        }
      }

      if (hasNotes) {
        summaries[index] = {
          sectionName: item.sectionName,
          title: item.name,
          content: notesContent
        };
      }

      completedCount++;
      const percent = Math.round((completedCount / itemsToProcess.length) * 85);
      job.percent = percent;
      logMessage(`[Finished] (${completedCount}/${itemsToProcess.length}) Analyzed file: "${item.name}"`);
    });

    const activeSummaries = summaries.filter(Boolean);

    if (activeSummaries.length === 0) {
      throw new Error('Could not retrieve or generate notes/transcripts for any files in this course.');
    }

    // 5. Final Synthesis
    job.percent = 85;
    logMessage('Compiling notes and synthesizing course-level master summary...');

    // Group notes by section for better organization
    const grouped = {};
    activeSummaries.forEach(s => {
      if (!grouped[s.sectionName]) grouped[s.sectionName] = [];
      grouped[s.sectionName].push(s);
    });

    let compilationText = '';
    Object.keys(grouped).forEach(secName => {
      compilationText += `Section: ${secName}\n`;
      grouped[secName].forEach(lecture => {
        compilationText += `Lecture/Material: ${lecture.title}\nSummary:\n${lecture.content}\n\n`;
      });
    });

    const synthesisPrompt = `
You are a master educator compiling a comprehensive study guide for a complete course.
Below are the individual summaries/notes for all the lectures/materials in this course.
Please generate a master Course Summary and Key Takeaways document.

Your guide must:
1. Be highly structured, organized by logical sections or major themes.
2. Provide a deep, comprehensive overview of the entire course content.
3. Group related concepts and eliminate duplicate explanations, redundant introductory remarks, and filler content.
4. Make sure not to lose any key technical details, definitions, code snippets, formulas, or crucial explanations.
5. Present a clear, premium, student-friendly layout with bullet points, bold key terms, and summaries.
6. Include a section for "Master Key Takeaways" summarizing the core lessons.
7. Very Important: You must preserve all clickable timestamp links (e.g., [12:35](timestamp:Section%201%2FVideo_1.mp4#755)) from the source summaries exactly as they are. When listing concepts, takeaways, or summaries derived from a specific lecture, ensure the corresponding timestamp link is included at the beginning of the bullet point so the student can navigate to it. Do not change the files, paths, or seconds in the links.

Format the output beautifully in Markdown. Do not include any meta-talk or introductory fluff like "Here is your course summary:". Start directly with the course title header.

Here are the individual lecture summaries:
---
${compilationText}
---
`;

    let masterSummary = await generateWithFireworks([{ role: 'user', content: synthesisPrompt }], { maxTokens: 65536 });
    if (!masterSummary) {
      throw new Error('Master summarization returned empty text.');
    }

    // Append a list of skipped files if any
    if (skippedFiles.length > 0) {
      masterSummary += `\n\n---\n\n> [!NOTE]\n> **Skipped Files:** The following file(s) did not have transcripts or subtitles, Modal transcription was not configured, and they were omitted from this summary:\n` + 
        skippedFiles.map(name => `> - ${name}`).join('\n') + '\n';
    }

    // Write final summary to disk
    const summaryFilePath = path.join(coursePath, 'course.summary.md');
    fs.writeFileSync(summaryFilePath, masterSummary, 'utf8');

    job.percent = 100;
    job.status = 'completed';
    job.result = masterSummary;
    logMessage('Course-level summary generated successfully and saved to disk!');

  } catch (err) {
    logMessage(`[Fatal Error] Course summary job failed: ${err.message}`);
    job.status = 'failed';
    job.error = err.message;
  }
}

// Map to cache active generations by path: path -> Promise<{ transcript, summary }>
const activeGenerations = new Map();

// Background queue for pre-generating summaries sequentially
const summaryQueue = [];
let queueIsProcessing = false;

function addToSummaryQueue(filePath) {
  if (summaryQueue.includes(filePath) || activeGenerations.has(filePath)) return;
  summaryQueue.push(filePath);
  processSummaryQueue();
}

async function processSummaryQueue() {
  if (queueIsProcessing) return;
  queueIsProcessing = true;

  while (summaryQueue.length > 0) {
    const nextPath = summaryQueue.shift();
    // Skip files whose notes were generated after they were queued (e.g. the user opened that lesson)
    const ext = path.extname(nextPath);
    if (fs.existsSync(nextPath.slice(0, -ext.length) + '.summary.md')) continue;
    console.log(`[Queue] Processing background summary for: ${nextPath}`);
    try {
      await generateSummaryForPath(nextPath);
    } catch (err) {
      console.error(`[Queue] Error processing background summary for ${nextPath}:`, err);
    }
  }

  queueIsProcessing = false;
}

// retranscribe: transcribe a lecture again even if it has a transcript (older ones have no captions)
async function generateSummaryForPath(filePath, { retranscribe = false } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Invalid file path');
  }

  // If there's an active generation for this exact file, return its promise
  if (activeGenerations.has(filePath)) {
    console.log(`[Generate] Summary for ${filePath} already in progress. Sharing promise.`);
    return activeGenerations.get(filePath);
  }

  const promise = (async () => {
    if (!isLlmConfigured()) {
      throw new Error(FIREWORKS_KEY_MISSING);
    }

    const ext = path.extname(filePath).toLowerCase();
    const baseWithoutExt = filePath.slice(0, -ext.length);
    const transcriptPath = baseWithoutExt + '.transcript.txt';
    const summaryPath = baseWithoutExt + '.summary.md';

    let transcript = '';
    let existingTranscript = '';
    if (fs.existsSync(transcriptPath)) {
      try {
        existingTranscript = fs.readFileSync(transcriptPath, 'utf8');
      } catch (err) {
        console.error('Error reading transcript file:', err);
      }
    }

    const type = getFileType(filePath);
    if (type === 'html') {
      if (existingTranscript && existingTranscript.trim()) {
        transcript = existingTranscript;
      } else {
        const htmlContent = fs.readFileSync(filePath, 'utf8');
        transcript = cleanHtmlText(htmlContent);
        fs.writeFileSync(transcriptPath, transcript, 'utf8');
      }
      const summary = await summarizeContent(transcript, 'document');
      fs.writeFileSync(summaryPath, summary, 'utf8');

      return { transcript, summary };
    } else if (type === 'pdf') {
      if (existingTranscript && existingTranscript.trim()) {
        transcript = existingTranscript;
      } else {
        const dataBuffer = fs.readFileSync(filePath);
        const pdfData = await pdfParse(dataBuffer);
        transcript = pdfData.text || '';
        if (!transcript.trim()) {
          throw new Error('PDF contains no extractable text.');
        }
        fs.writeFileSync(transcriptPath, transcript, 'utf8');
      }
      const summary = await summarizeContent(transcript, 'document');
      fs.writeFileSync(summaryPath, summary, 'utf8');

      return { transcript, summary };
    } else if (type === 'docx') {
      if (existingTranscript && existingTranscript.trim()) {
        transcript = existingTranscript;
      } else {
        transcript = (await mammoth.extractRawText({ path: filePath })).value;
        if (!transcript.trim()) {
          throw new Error('Word document contains no text.');
        }
        fs.writeFileSync(transcriptPath, transcript, 'utf8');
      }
      const summary = await summarizeContent(transcript, 'document');
      fs.writeFileSync(summaryPath, summary, 'utf8');

      return { transcript, summary };
    } else if (type === 'text' || type === 'code') {
      if (existingTranscript && existingTranscript.trim()) {
        transcript = existingTranscript;
      } else {
        transcript = fs.readFileSync(filePath, 'utf8');
        fs.writeFileSync(transcriptPath, transcript, 'utf8');
      }
      const summary = await summarizeContent(transcript, 'document');
      fs.writeFileSync(summaryPath, summary, 'utf8');

      return { transcript, summary };
    }

    if (!isMediaType(type)) {
      throw new Error('AI notes are not available for this file type.');
    }

    // Video and audio: use the transcript, else subtitles, else transcribe on Modal
    let subtitlePath = '';
    if (fs.existsSync(baseWithoutExt + '.vtt')) {
      subtitlePath = baseWithoutExt + '.vtt';
    } else if (fs.existsSync(baseWithoutExt + '.srt')) {
      subtitlePath = baseWithoutExt + '.srt';
    }

    if (!retranscribe && existingTranscript && existingTranscript.trim()) {
      transcript = existingTranscript;
    } else if (subtitlePath) {
      console.log(`[Transcript] Found subtitles for ${filePath}. Parsing track content...`);
      const subtitleContent = fs.readFileSync(subtitlePath, 'utf8');
      transcript = cleanSubtitleText(subtitleContent);
      fs.writeFileSync(transcriptPath, transcript, 'utf8');
    } else {
      if (!isTranscriptionConfigured()) {
        throw new Error('Modal is not configured. Run "modal token set" (or set MODAL_TOKEN_ID / MODAL_TOKEN_SECRET in .env) to enable transcription.');
      }
      const transcription = await transcribeVideoWithModal(filePath);
      transcript = transcription.transcript;
      fs.writeFileSync(transcriptPath, transcript, 'utf8');
      subtitlePath = saveCaptions(filePath, transcription.captions);
    }

    const relPath = getRelativePathFromAbsolute(filePath);
    const summary = await summarizeContent(transcript, 'video', relPath);
    fs.writeFileSync(summaryPath, summary, 'utf8');

    return { transcript, summary, subtitlePath: subtitlePath || null };
  })();

  activeGenerations.set(filePath, promise);

  try {
    return await promise;
  } finally {
    activeGenerations.delete(filePath);
  }
}

// --- SINGLE VIDEO NOTES GENERATION ENDPOINT ---
app.post('/api/video/generate-transcript', async (req, res) => {
  const videoPath = req.body.path;
  if (!videoPath || !fs.existsSync(videoPath) || !isInWatchedFolder(videoPath)) {
    return res.status(400).send({ error: 'Invalid file path' });
  }

  try {
    const result = await generateSummaryForPath(videoPath, { retranscribe: req.body.retranscribe === true });
    res.send({
      success: true,
      transcript: result.transcript,
      summary: result.summary,
      subtitlePath: result.subtitlePath || null
    });
  } catch (err) {
    console.error('Error generating transcript/summary:', err);
    res.status(500).send({ error: err.message || 'Failed to generate transcript and summary' });
  }
});

// --- BATCH PRE-GENERATE NEIGHBOR SUMMARIES ENDPOINT ---
app.post('/api/video/pregenerate-summaries', (req, res) => {
  const { paths } = req.body;
  if (!paths || !Array.isArray(paths)) {
    return res.status(400).send({ error: 'paths array is required' });
  }

  const queued = [];
  for (const filePath of paths) {
    if (!filePath || !fs.existsSync(filePath) || !isInWatchedFolder(filePath)) continue;

    // Check if summary already exists
    const ext = path.extname(filePath).toLowerCase();
    const baseWithoutExt = filePath.slice(0, -ext.length);
    const summaryPath = baseWithoutExt + '.summary.md';

    if (!fs.existsSync(summaryPath)) {
      addToSummaryQueue(filePath);
      queued.push(filePath);
    }
  }

  res.send({ success: true, queuedCount: queued.length, queuedPaths: queued });
});


// Chat with video transcript endpoint
app.post('/api/video/chat', async (req, res) => {
  const { path: videoPath, message, history } = req.body;
  if (!videoPath || !fs.existsSync(videoPath) || !isInWatchedFolder(videoPath)) {
    return res.status(400).send({ error: 'Invalid file path' });
  }
  if (!message) {
    return res.status(400).send({ error: 'Message is required' });
  }

  if (!isLlmConfigured()) {
    return res.status(400).send({ error: FIREWORKS_KEY_MISSING });
  }

  const ext = path.extname(videoPath);
  const baseWithoutExt = videoPath.slice(0, -ext.length);
  const transcriptPath = baseWithoutExt + '.transcript.txt';

  let transcript = '';
  if (fs.existsSync(transcriptPath)) {
    try {
      transcript = fs.readFileSync(transcriptPath, 'utf8').trim();
    } catch (err) {
      console.error('Error reading transcript file:', err);
    }
  }

  if (!transcript) {
    return res.status(400).send({ error: 'No transcript available. Please generate AI notes first.' });
  }

  try {
    const isVideo = isMediaType(getFileType(videoPath));

    const systemInstruction = `You are an expert AI tutor helping a student study a course.
Below is the ${isVideo ? 'transcript of the recorded lecture they are currently studying' : 'content of the document they are currently studying'}.
Analyze the content carefully and answer the student's questions based on it.
If the answer is not directly found in the text, you can use your general knowledge to supplement it, but prioritize information from the course material and make sure to clarify when you are adding external context.
Keep your answers clear, educational, and formatting-rich (use markdown, code snippets, lists, bold terms).

Here is the ${isVideo ? 'transcript of the lecture' : 'content of the document'}:
---
${transcript}
---`;

    const messages = [{ role: 'system', content: systemInstruction }];
    if (history && Array.isArray(history)) {
      history.forEach(item => {
        messages.push({
          role: item.role === 'model' || item.role === 'assistant' ? 'assistant' : 'user',
          content: item.content
        });
      });
    }
    messages.push({ role: 'user', content: message });

    const response = await generateWithFireworks(messages);

    res.send({ response });
  } catch (err) {
    console.error('Error in video chat:', err);
    res.status(500).send({ error: err.message || 'Failed to get AI response' });
  }
});

// --- SEARCH ---
// Lesson names, transcripts, AI notes and lesson-page text, split into chunks of a few hundred characters and
// searched with a plain scan: a library's text fits in memory, and no inverted index keeps it small. Text from
// lesson pages is cached on disk, since reading every saved page the first time is slow.
const PAGE_TEXT_FILE = path.join(CACHE_DIR, 'page-text.json');
const SEARCH_REFRESH_MS = 2 * 60 * 1000;
const SEARCH_KINDS = ['title', 'transcript', 'notes', 'page', 'course-notes'];
// Matches in a lesson's name count for more; its notes condense the lesson
const KIND_WEIGHTS = { title: 2.5, notes: 1.2, 'course-notes': 1.1, transcript: 1, page: 1 };
const STOPWORDS = new Set(('a an and are as at be but by can could do does for from give has have how i if in into is it its ' +
  'me my no not of on or our so than that the their them then there these they this to us was we what when where which ' +
  'who why will with would you your').split(' '));
// index: { chunks, totalLength } (the first build is searchable while it fills in); builtAt: when it finished
const search = { index: { chunks: [], totalLength: 0 }, builtAt: 0, building: null, progress: null };
let pageTextCache = null; // { [path]: { size, mtimeMs, text } }
let pageTextChanged = false;

function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return '';
  }
}

// Split text into chunks of about `size` characters, at line breaks or, inside long paragraphs, sentence ends
function splitIntoChunks(text, size = 700) {
  const chunks = [];
  let current = '';
  const add = (piece) => {
    if (current && current.length + piece.length > size) {
      chunks.push(current.trim());
      current = '';
    }
    current += `${piece} `;
  };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.length > size) {
      (trimmed.match(/[^.!?]+[.!?]*/g) || [trimmed]).forEach(add);
    } else {
      add(trimmed);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// Lecture transcripts: a chunk per [MM:SS] paragraph, starting at its time. Short ones (subtitle cues) are
// merged, and marks ([offset in the text, seconds]) keep each one's time, so results open where they matched.
function chunkTimedTranscript(text) {
  const stamps = [...text.matchAll(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g)];
  if (stamps.length === 0) {
    return splitIntoChunks(text).map((chunkText) => ({ text: chunkText, start: null }));
  }
  const chunks = [];
  let current = null;
  stamps.forEach((match, i) => {
    const end = i + 1 < stamps.length ? stamps[i + 1].index : text.length;
    const segment = text.slice(match.index + match[0].length, end).replace(/\s+/g, ' ').trim();
    if (!segment) return;
    const seconds = timestampToSeconds(match[1]);
    if (!current || current.text.length > 200) {
      if (current) chunks.push(current);
      current = { text: segment, start: seconds, marks: [[0, seconds]] };
    } else {
      current.marks.push([current.text.length + 1, seconds]);
      current.text += ` ${segment}`;
    }
  });
  if (current) chunks.push(current);
  return chunks;
}

// When a result's chunk merged several transcript paragraphs, the time of the one holding the first match
function startOfMatch(chunk, { terms, phrases }) {
  const positions = [...phrases, ...terms].map((needle) => chunk.lower.indexOf(needle)).filter((i) => i >= 0);
  if (!chunk.marks || positions.length === 0) return chunk.start;
  const first = Math.min(...positions);
  let start = chunk.start;
  for (const [offset, seconds] of chunk.marks) {
    if (offset > first) break;
    start = seconds;
  }
  return start;
}

function markdownToPlainText(markdown) {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // Links become their text
    .replace(/^\s*(?:[-+*]|\d+\.)\s+/gm, '')
    .replace(/[*_`>#|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// AI notes: small chunks at headings and list items; a chunk's time is its first timestamp link
function chunkNotes(markdown) {
  const blocks = markdown.split(/\n(?=\s*(?:[-*]\s|#{1,6}\s|\d+\.\s))|\n\s*\n/);
  const chunks = [];
  let current = '';
  const flush = () => {
    const text = markdownToPlainText(current);
    if (text) {
      const link = current.match(/\(timestamp:[^)#]*#(\d+(?:\.\d+)?)\)/);
      const stamp = current.match(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/);
      chunks.push({ text, start: link ? parseFloat(link[1]) : stamp ? timestampToSeconds(stamp[1]) : null });
    }
    current = '';
  };
  for (const block of blocks) {
    if (current && current.length + block.length > 400) flush();
    current += `${block}\n`;
  }
  flush();
  return chunks;
}

// Visible text of a saved lesson page (cached by size and modification time)
function getPageText(filePath, stat) {
  const cached = pageTextCache[filePath];
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.text;
  }
  const html = fs.readFileSync(filePath, 'utf8');
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [null, html])[1];
  const text = cleanHtmlText(body.replace(/<(svg|noscript|nav|footer)\b[\s\S]*?<\/\1>/gi, ' '))
    .replace(/&#(\d+);/g, (match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => String.fromCodePoint(parseInt(code, 16)));
  pageTextCache[filePath] = { size: stat.size, mtimeMs: stat.mtimeMs, text };
  pageTextChanged = true;
  return text;
}

// marks: see chunkTimedTranscript (its text is already normalized, so their offsets still hold)
function makeChunk(course, item, kind, text, start, marks) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return {
    marks: isMediaType(item && item.type) ? marks : undefined,
    courseId: course.id,
    courseTitle: course.title,
    filePath: item ? item.path : null,
    itemName: item ? item.name : null,
    itemType: item ? item.type : null,
    sectionName: item ? item.sectionName : null,
    kind,
    start: isMediaType(item && item.type) ? start : null,
    text: clean,
    lower: clean.toLowerCase(),
    length: clean.split(' ').length
  };
}

async function buildSearchIndex() {
  if (!pageTextCache) {
    try {
      pageTextCache = JSON.parse(fs.readFileSync(PAGE_TEXT_FILE, 'utf8'));
    } catch (err) {
      pageTextCache = {};
    }
  }
  const next = { chunks: [], totalLength: 0 };
  if (!search.builtAt) search.index = next; // Nothing to search yet, so let results appear as it fills in
  const add = (chunk) => {
    if (!chunk.text) return;
    next.chunks.push(chunk);
    next.totalLength += chunk.length;
  };

  const courses = scanAllCourses();
  const total = courses.reduce((sum, course) => sum + course.sections.reduce((n, sec) => n + sec.items.length, 0), 0);
  let done = 0;
  const seenPages = new Set();
  const step = async () => {
    done++;
    search.progress = { done, total };
    if (done % 10 === 0) await new Promise((resolve) => setImmediate(resolve)); // Let requests in
  };

  for (const course of courses) {
    const items = course.sections.flatMap((sec) => sec.items.map((item) => ({ ...item, sectionName: sec.name })));

    // Lesson pages, minus lines repeated on most pages of their section or of the course (menus, a module's
    // outline): otherwise every saved page would match every lesson title
    const pages = [];
    for (const item of items.filter((i) => i.type === 'html')) {
      try {
        const lines = getPageText(item.path, fs.statSync(item.path)).split('\n').map((line) => line.trim()).filter(Boolean);
        pages.push({ item, lines });
        seenPages.add(item.path);
      } catch (err) {
        console.error(`[Search] Error reading ${item.path}:`, err.message);
      }
      await step();
    }
    // Returns a test for lines that appear on more than half of the given pages (when there are enough to tell)
    const repeatedIn = (group) => {
      const counts = new Map();
      group.forEach(({ lines }) => new Set(lines).forEach((line) => counts.set(line, (counts.get(line) || 0) + 1)));
      const limit = Math.max(3, group.length / 2);
      return (line) => group.length >= 4 && counts.get(line) > limit;
    };
    const repeatedInCourse = repeatedIn(pages);
    const repeatedInSection = new Map();
    for (const page of pages) {
      const section = page.item.sectionName;
      if (!repeatedInSection.has(section)) {
        repeatedInSection.set(section, repeatedIn(pages.filter((p) => p.item.sectionName === section)));
      }
    }
    for (const { item, lines } of pages) {
      const inSection = repeatedInSection.get(item.sectionName);
      const text = lines.filter((line) => !repeatedInCourse(line) && !inSection(line)).join('\n');
      splitIntoChunks(text).forEach((chunkText) => add(makeChunk(course, item, 'page', chunkText, null)));
    }

    for (const item of items) {
      add(makeChunk(course, item, 'title', `${item.name} ${item.sectionName === 'General' ? '' : item.sectionName}`, null));
      const base = item.path.slice(0, -path.extname(item.path).length);
      // A lesson page's AI transcript is the same text, with its menus
      const transcript = item.type === 'html' ? '' : readTextIfExists(`${base}.transcript.txt`);
      if (transcript.trim()) {
        const chunks = isMediaType(item.type)
          ? chunkTimedTranscript(transcript)
          : splitIntoChunks(transcript).map((chunkText) => ({ text: chunkText, start: null }));
        chunks.forEach((chunk) => add(makeChunk(course, item, 'transcript', chunk.text, chunk.start, chunk.marks)));
      }
      const notes = readTextIfExists(`${base}.summary.md`);
      if (notes.trim()) {
        chunkNotes(notes).forEach((chunk) => add(makeChunk(course, item, 'notes', chunk.text, chunk.start)));
      }
      if (item.type !== 'html') await step();
    }

    const courseNotes = readTextIfExists(path.join(course.path, 'course.summary.md'));
    if (courseNotes.trim()) {
      chunkNotes(courseNotes).forEach((chunk) => add(makeChunk(course, null, 'course-notes', chunk.text, null)));
    }
  }

  search.index = next;
  search.builtAt = Date.now();
  search.progress = null;

  // Keep cached page text only for pages that still exist; save it if anything was added or removed
  for (const filePath of Object.keys(pageTextCache)) {
    if (!seenPages.has(filePath)) {
      delete pageTextCache[filePath];
      pageTextChanged = true;
    }
  }
  if (pageTextChanged) {
    pageTextChanged = false;
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(`${PAGE_TEXT_FILE}.tmp`, JSON.stringify(pageTextCache), 'utf8');
      fs.renameSync(`${PAGE_TEXT_FILE}.tmp`, PAGE_TEXT_FILE);
    } catch (err) {
      console.error('Error saving page text cache:', err);
    }
  }
  console.log(`[Search] Indexed ${next.chunks.length} chunks from ${total} files.`);
}

// Builds the index if there isn't one, or refreshes it if it's older than SEARCH_REFRESH_MS
function ensureSearchIndex() {
  if (search.building) return search.building;
  if (search.builtAt && Date.now() - search.builtAt < SEARCH_REFRESH_MS) return Promise.resolve();
  search.building = buildSearchIndex()
    .catch((err) => console.error('Error building search index:', err))
    .finally(() => { search.building = null; });
  return search.building;
}

// Search terms (stopwords dropped, unless that leaves nothing) and "quoted phrases"
function parseQuery(query) {
  const phrases = [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase().trim()).filter(Boolean);
  const words = query.replace(/"[^"]*"/g, ' ').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const terms = [...new Set(words.filter((word) => word.length > 1 && !STOPWORDS.has(word)))];
  return { terms: terms.length > 0 || phrases.length > 0 ? terms : [...new Set(words)], phrases };
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Chunks ranked by BM25, matching each term at the start of a word (so "lesson" finds "lessons"); chunks with
// more of the terms rank higher, and phrases must appear as written
function searchChunks({ terms, phrases }, { courseId = null, kinds = null } = {}) {
  const { chunks: allChunks, totalLength } = search.index;
  const averageLength = allChunks.length ? totalLength / allChunks.length : 1;
  const chunks = allChunks.filter((c) => (!courseId || c.courseId === courseId) && (!kinds || kinds.includes(c.kind)));
  const patterns = terms.map((term) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}`, 'gu'));
  const termCounts = terms.map(() => new Map()); // chunk index -> occurrences
  const candidates = [];
  chunks.forEach((chunk, i) => {
    if (phrases.some((phrase) => !chunk.lower.includes(phrase))) return;
    let matched = phrases.length > 0;
    terms.forEach((term, j) => {
      if (!chunk.lower.includes(term)) return;
      const count = (chunk.lower.match(patterns[j]) || []).length;
      if (count) {
        termCounts[j].set(i, count);
        matched = true;
      }
    });
    if (matched) candidates.push(i);
  });

  return candidates.map((i) => {
    const chunk = chunks[i];
    let score = phrases.length > 0 ? 1 : 0;
    let termsFound = 0;
    terms.forEach((term, j) => {
      const count = termCounts[j].get(i);
      if (!count) return;
      termsFound++;
      const docs = termCounts[j].size;
      const idf = Math.log(1 + (chunks.length - docs + 0.5) / (docs + 0.5));
      score += idf * (count * 2.2) / (count + 1.2 * (0.25 + 0.75 * chunk.length / averageLength));
    });
    const coverage = terms.length ? termsFound / terms.length : 1;
    return { chunk, score: score * coverage * coverage * KIND_WEIGHTS[chunk.kind] };
  }).sort((a, b) => b.score - a.score);
}

// About two lines of text around the first match, with the ranges of matched words to highlight
function makeSnippet(text, { terms, phrases }, radius = 100) {
  const lower = text.toLowerCase();
  const needles = [...phrases, ...terms];
  const positions = needles.map((needle) => lower.indexOf(needle)).filter((i) => i >= 0);
  const first = positions.length ? Math.min(...positions) : 0;
  let start = Math.max(0, first - radius);
  let end = Math.min(text.length, first + radius * 2);
  if (start > 0) start = text.indexOf(' ', start) + 1 || start;
  if (end < text.length) end = Math.max(text.lastIndexOf(' ', end), first + 1);
  const snippet = `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;

  const ranges = [];
  for (const needle of needles) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}[\\p{L}\\p{N}]*`, 'giu');
    for (const match of snippet.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const highlights = [];
  for (const range of ranges) {
    const last = highlights[highlights.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else highlights.push(range);
  }
  return { snippet, highlights };
}

// The passages most relevant to a question, each labelled with its lesson and, for lectures, a timestamp link
// the model can cite. When a question matches little (e.g. "summarize the course"), lesson notes fill in.
function retrieveCourseExcerpts(courseId, question, budget = 60000) {
  const query = parseQuery(question);
  const picked = searchChunks(query, { courseId })
    .filter(({ chunk }) => chunk.kind !== 'title') // A name alone tells the model little
    .slice(0, 30)
    .map(({ chunk }) => chunk);
  if (picked.length < 5) {
    const notes = search.index.chunks.filter((c) => c.courseId === courseId && c.kind === 'notes' && !picked.includes(c));
    picked.push(...notes);
  }

  const parts = [];
  let used = 0;
  for (const chunk of picked) {
    const where = chunk.sectionName && chunk.sectionName !== 'General' ? ` (${chunk.sectionName})` : '';
    let source = `${chunk.kind === 'page' ? 'Page' : 'Lesson'} "${chunk.itemName}"${where}`;
    const start = startOfMatch(chunk, query);
    if (start !== null) {
      const link = `timestamp:${encodeURIComponent(getRelativePathFromAbsolute(chunk.filePath))}#${Math.floor(start)}`;
      source = `Lecture "${chunk.itemName}"${where} at [${formatSecondsToTimestamp(start).slice(1, -1)}](${link})`;
    }
    const part = `[${parts.length + 1}] ${source}\n${chunk.text}`;
    if (used + part.length > budget) break;
    parts.push(part);
    used += part.length;
  }
  return parts.join('\n\n');
}

// One result per lesson (its best matching chunk, and how many others matched), best first
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const kinds = SEARCH_KINDS.includes(req.query.kind) ? [req.query.kind] : null;
  ensureSearchIndex();
  if (!q) {
    return res.send({ results: [], total: 0, indexing: !!search.building, progress: search.progress });
  }

  const query = parseQuery(q);
  const byLesson = new Map();
  for (const { chunk } of searchChunks(query, { courseId: req.query.courseId || null, kinds })) {
    const key = chunk.filePath || `course:${chunk.courseId}`;
    const seen = byLesson.get(key);
    if (seen) seen.matches++;
    else byLesson.set(key, { chunk, matches: 1 });
  }
  const results = [...byLesson.values()].slice(0, limit).map(({ chunk, matches }) => ({
    courseId: chunk.courseId,
    courseTitle: chunk.courseTitle,
    filePath: chunk.filePath,
    itemName: chunk.itemName,
    itemType: chunk.itemType,
    sectionName: chunk.sectionName,
    kind: chunk.kind,
    start: startOfMatch(chunk, query),
    matches,
    ...makeSnippet(chunk.text, query)
  }));
  res.send({ results, total: byLesson.size, indexing: !!search.building, progress: search.progress });
});

// Chat with entire course endpoint
app.post('/api/course/chat', async (req, res) => {
  const { courseId, message, history } = req.body;
  if (!courseId) {
    return res.status(400).send({ error: 'courseId is required' });
  }
  if (!message) {
    return res.status(400).send({ error: 'Message is required' });
  }

  let coursePath;
  try {
    coursePath = Buffer.from(courseId, 'base64url').toString('utf8');
  } catch (err) {
    return res.status(400).send({ error: 'Invalid courseId' });
  }

  if (!fs.existsSync(coursePath)) {
    return res.status(400).send({ error: 'Course path does not exist on disk' });
  }
  if (!isInWatchedFolder(coursePath)) {
    return res.status(403).send({ error: OUTSIDE_WATCHED_FOLDERS });
  }

  if (!isLlmConfigured()) {
    return res.status(400).send({ error: FIREWORKS_KEY_MISSING });
  }

  try {
    // Ground the answer in the course summary (if one was generated) plus the passages most relevant to this
    // question and the ones just before it, found with the search index
    if (search.builtAt) {
      ensureSearchIndex(); // Refreshes in the background if it's out of date
    } else {
      await ensureSearchIndex();
    }
    const summaryFilePath = path.join(coursePath, 'course.summary.md');
    const recentQuestions = (Array.isArray(history) ? history : [])
      .filter((item) => item.role === 'user' && typeof item.content === 'string')
      .slice(-2)
      .map((item) => item.content);
    const excerpts = retrieveCourseExcerpts(courseId, [...recentQuestions, message].join(' '));

    let contextText = '';
    if (fs.existsSync(summaryFilePath)) {
      contextText += `## Course summary\n${fs.readFileSync(summaryFilePath, 'utf8').slice(0, 30000)}\n\n`;
    }
    if (excerpts) {
      contextText += `## Excerpts from the lessons\n${excerpts}`;
    }

    if (!contextText.trim()) {
      return res.status(400).send({ error: 'No course materials have been transcribed or summarized yet. Please generate AI notes for lectures or generate the Course Summary first.' });
    }

    const systemInstruction = `You are a master AI tutor helping a student study a complete course.
Below is context from the course: the course-level summary if one exists, and excerpts from lecture transcripts, lesson notes and lesson pages, picked for the student's question.
Use this context to answer the student's questions about the entire course. Explain concepts clearly, relate topics across different lectures, and synthesize information.
Each excerpt is labelled with its source. When you use an excerpt from a lecture, cite it with its timestamp link exactly as given (for example "[12:35](timestamp:...)"), so the student can jump to that moment. Never invent links.
If the answer is not found in the course context, you may use your general knowledge, but prioritize the course content and mention when you are adding external knowledge.
Format your responses using clean markdown (bold terms, lists, tables, code blocks).

Here is the course context:
---
${contextText}
---`;

    const messages = [{ role: 'system', content: systemInstruction }];
    if (history && Array.isArray(history)) {
      history.forEach(item => {
        messages.push({
          role: item.role === 'model' || item.role === 'assistant' ? 'assistant' : 'user',
          content: item.content
        });
      });
    }
    messages.push({ role: 'user', content: message });

    const response = await generateWithFireworks(messages);

    res.send({ response });
  } catch (err) {
    console.error('Error in course chat:', err);
    res.status(500).send({ error: err.message || 'Failed to get AI response' });
  }
});

// --- COURSE SUMMARY API ENDPOINTS ---

// --- COURSE SUMMARY API ENDPOINTS ---

app.post('/api/course/generate-summary', (req, res) => {
  const { courseId, selectedFiles } = req.body;
  if (!courseId) return res.status(400).send({ error: 'courseId is required' });

  let coursePath;
  try {
    coursePath = Buffer.from(courseId, 'base64url').toString('utf8');
  } catch (err) {
    return res.status(400).send({ error: 'Invalid courseId' });
  }

  if (!fs.existsSync(coursePath)) {
    return res.status(400).send({ error: 'Course path does not exist on disk' });
  }
  if (!isInWatchedFolder(coursePath)) {
    return res.status(403).send({ error: OUTSIDE_WATCHED_FOLDERS });
  }

  // If already processing, return status
  if (activeJobs[courseId] && activeJobs[courseId].status === 'processing') {
    return res.send({ status: 'processing', progress: activeJobs[courseId].progress, percent: activeJobs[courseId].percent });
  }

  // Start background job
  activeJobs[courseId] = {
    status: 'processing',
    progress: 'Initializing...',
    logs: ['[System] Started course summary generation...'],
    percent: 0,
    error: null,
    result: null
  };

  // Trigger processing asynchronously
  runCourseSummaryJob(courseId, coursePath, selectedFiles).catch(err => {
    console.error(`Course summary job failed for ${courseId}:`, err);
    activeJobs[courseId].status = 'failed';
    activeJobs[courseId].progress = 'Failed';
    activeJobs[courseId].error = err.message || 'Unknown error';
  });

  res.send({ status: 'processing', progress: 'Initializing...', percent: 0 });
});

app.get('/api/course/summary-status', (req, res) => {
  const { courseId } = req.query;
  if (!courseId) return res.status(400).send({ error: 'courseId is required' });

  let coursePath;
  try {
    coursePath = Buffer.from(courseId, 'base64url').toString('utf8');
  } catch (err) {
    return res.status(400).send({ error: 'Invalid courseId' });
  }
  if (!isInWatchedFolder(coursePath)) {
    return res.status(403).send({ error: OUTSIDE_WATCHED_FOLDERS });
  }

  const summaryFilePath = path.join(coursePath, 'course.summary.md');
  const hasSummaryOnDisk = fs.existsSync(summaryFilePath);

  const job = activeJobs[courseId];
  if (job) {
    res.send({
      status: job.status,
      progress: job.progress,
      percent: job.percent,
      logs: job.logs.join('\n'),
      error: job.error,
      hasSummary: hasSummaryOnDisk || job.status === 'completed',
      summary: job.status === 'completed' ? job.result : (hasSummaryOnDisk ? fs.readFileSync(summaryFilePath, 'utf8') : null)
    });
  } else {
    res.send({
      status: hasSummaryOnDisk ? 'completed' : 'idle',
      progress: hasSummaryOnDisk ? 'Completed' : 'Not started',
      percent: hasSummaryOnDisk ? 100 : 0,
      logs: hasSummaryOnDisk ? '[System] Loaded course summary from disk.' : '[System] Ready to generate.',
      error: null,
      hasSummary: hasSummaryOnDisk,
      summary: hasSummaryOnDisk ? fs.readFileSync(summaryFilePath, 'utf8') : null
    });
  }
});

// Start Server
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Course Viewer server running on http://localhost:${PORT}`);
  });
}

module.exports = {
  formatSecondsToTimestamp,
  formatTranscriptSegments,
  formatSegmentsAsVtt,
  ensureSearchIndex,
  retrieveCourseExcerpts,
  app,
  formatTimestamp
};
