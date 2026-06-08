const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { exec } = require('child_process');
const { SpeechClient } = require('@google-cloud/speech').v2;
const { Storage } = require('@google-cloud/storage');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3005;
const DB_FILE = path.join(__dirname, 'db.json');

const IGNORE_DIRS = ['node_modules', 'dist', 'build', '.git', 'venv', '.env', 'env', 'bower_components'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif'];
const CODE_EXTENSIONS = ['.js', '.py', '.sh', '.json', '.css', '.go', '.rs', '.java', '.cpp', '.c', '.h', '.yaml', '.yml', '.xml', '.sql', '.ini', '.conf'];

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Database
let db = {
  folders: [
    '/Users/maulik/Downloads/courses',
    '/Users/maulik/Downloads/Mega Downloads'
  ],
  progress: {},
  gcpConfig: {
    projectId: '',
    bucketName: '',
    location: 'global',
    speechLocation: 'us-central1'
  }
};

if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    db = JSON.parse(raw);
    // Ensure gcpConfig exists
    if (!db.gcpConfig) {
      db.gcpConfig = {
        projectId: '',
        bucketName: '',
        location: 'global',
        speechLocation: 'us-central1'
      };
      saveDb();
    }
  } catch (err) {
    console.error('Error reading db.json, creating new one', err);
  }
} else {
  saveDb();
}

function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving db.json', err);
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
  const videoItems = [];

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
          let type = 'other';

          if (['.mp4', '.mkv', '.mov', '.webm', '.avi'].includes(ext)) {
            type = 'video';
          } else if (ext === '.pdf') {
            type = 'pdf';
          } else if (['.html', '.htm'].includes(ext)) {
            type = 'html';
          } else if (['.txt', '.md'].includes(ext)) {
            type = 'text';
          } else if (IMAGE_EXTENSIONS.includes(ext)) {
            type = 'image';
          } else if (CODE_EXTENSIONS.includes(ext)) {
            type = 'code';
          } else if (['.vtt', '.srt', '.DS_Store'].includes(ext)) {
            continue; // Skip files that are not main learning materials
          } else {
            type = 'other'; // docs, zips, etc.
          }

          if (!sectionsMap[currentSectionName]) {
            sectionsMap[currentSectionName] = [];
          }

          const itemObj = {
            name: item.name,
            path: fullPath,
            relativePath: path.relative(coursePath, fullPath),
            type: type,
            extension: ext,
            size: fs.statSync(fullPath).size
          };

          if (type === 'video') {
            videoItems.push(itemObj);
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
  for (const video of videoItems) {
    const videoPathWithoutExt = video.path.slice(0, -path.extname(video.path).length);
    if (allSubtitles[videoPathWithoutExt]) {
      video.subtitlePath = allSubtitles[videoPathWithoutExt];
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
          const ext = path.extname(item.name).toLowerCase();
          if (['.mp4', '.mkv', '.mov', '.webm', '.avi', '.pdf', '.html', '.htm', '.txt', '.md'].includes(ext)) {
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

// Get single item progress
app.get('/api/progress', (req, res) => {
  res.send(db.progress);
});

// Save progress for an item
app.post('/api/progress', (req, res) => {
  const { filePath, currentTime, duration, completed, skipped } = req.body;
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
  const keys = Object.keys(db.progress);
  let count = 0;
  for (const filePath of keys) {
    const isSame = filePath === coursePath;
    const isInside = filePath.startsWith(coursePath + path.sep);
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
      if (item.type === 'video') {
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


// Video Streaming Endpoint with Range Requests Support
app.get('/api/video', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) {
    return res.status(400).send('Path is required');
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!['.mp4', '.mkv', '.mov', '.webm', '.avi'].includes(ext)) {
    return res.status(403).send('Forbidden file type');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  let contentType = 'video/mp4';
  if (ext === '.webm') contentType = 'video/webm';
  else if (ext === '.mkv') contentType = 'video/x-matroska';
  else if (ext === '.avi') contentType = 'video/x-msvideo';
  else if (ext === '.mov') contentType = 'video/quicktime';

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize) {
      res.status(416).send('Requested range not satisfiable\n' + start + ' >= ' + fileSize);
      return;
    }

    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': contentType,
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// Subtitles stream
app.get('/api/subtitle', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) {
    return res.status(400).send('Path is required');
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.vtt') {
    res.setHeader('Content-Type', 'text/vtt');
    fs.createReadStream(filePath).pipe(res);
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
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  const ext = path.extname(filePath).toLowerCase();
  let contentType = 'application/octet-stream';

  const textExtensions = ['.txt', '.md', ...CODE_EXTENSIONS];

  if (ext === '.pdf') {
    contentType = 'application/pdf';
  } else if (ext === '.html' || ext === '.htm') {
    contentType = 'text/html';
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
  fs.createReadStream(filePath).pipe(res);
});

// Reveal file in Mac Finder
app.post('/api/open-in-finder', (req, res) => {
  const filePath = req.body.path;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(400).send('Invalid path');
  }

  const escapedPath = filePath.replace(/"/g, '\\"');
  exec(`open -R "${escapedPath}"`, (err) => {
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
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(400).send('Invalid path');
  }

  const escapedPath = filePath.replace(/"/g, '\\"');
  exec(`open "${escapedPath}"`, (err) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Failed to open file in default app');
    }
    res.send({ success: true });
  });
});

// --- GCP CONFIG ENDPOINTS ---

app.get('/api/gcp-config', (req, res) => {
  res.send(db.gcpConfig || { projectId: '', bucketName: '', location: 'global', speechLocation: 'us-central1' });
});

app.post('/api/gcp-config', (req, res) => {
  const { projectId, bucketName, location, speechLocation } = req.body;
  db.gcpConfig = {
    projectId: projectId || '',
    bucketName: bucketName || '',
    location: location || 'global',
    speechLocation: speechLocation || 'us-central1'
  };
  saveDb();
  res.send({ success: true, gcpConfig: db.gcpConfig });
});

// --- VIDEO EXTRA METADATA ENDPOINTS ---

app.get('/api/video/metadata', (req, res) => {
  const videoPath = req.query.path;
  if (!videoPath || !fs.existsSync(videoPath)) {
    return res.status(400).send('Invalid file path');
  }

  const ext = path.extname(videoPath);
  const baseWithoutExt = videoPath.slice(0, -ext.length);
  const transcriptPath = baseWithoutExt + '.transcript.txt';
  const summaryPath = baseWithoutExt + '.summary.md';

  const metadata = {
    hasTranscript: fs.existsSync(transcriptPath),
    hasSummary: fs.existsSync(summaryPath),
    transcript: '',
    summary: ''
  };

  if (metadata.hasTranscript) {
    try {
      metadata.transcript = fs.readFileSync(transcriptPath, 'utf8');
    } catch (err) {
      console.error('Error reading transcript file:', err);
    }
  }

  if (metadata.hasSummary) {
    try {
      metadata.summary = fs.readFileSync(summaryPath, 'utf8');
    } catch (err) {
      console.error('Error reading summary file:', err);
    }
  }

  res.send(metadata);
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

// Call Vertex AI Gemini to generate summary from transcript or document notes
async function summarizeContent(content, type, gcp, relativePath = '') {
  if (!gcp.projectId) {
    throw new Error('GCP Project ID is required for Vertex AI summarization.');
  }
  const isTranscript = type === 'video' || type === 'transcript';
  console.log(`[Vertex AI] Summarizing ${type} with gemini-3.5-flash (location: ${gcp.location || 'global'})...`);
  const location = gcp.location || 'global';
  const ai = new GoogleGenAI({
    enterprise: true,
    project: gcp.projectId,
    location: location,
  });

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

  const genResult = await ai.models.generateContent({
    model: 'gemini-3.5-flash',
    contents: prompt,
  });

  let summary = genResult.text;
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

// Transcribe audio using Google Cloud Speech-to-Text V2 Chirp
async function transcribeVideoWithChirp(videoPath, gcp) {
  const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const tempAudioPath = path.join(__dirname, `temp_audio_${uniqueId}.wav`);
  const gcsDestination = `course-viewer-transcripts/audio_${uniqueId}.wav`;
  let gcsUri = null;

  try {
    // 1. Extract audio locally (one at a time)
    const currentLock = ffmpegMutex;
    let resolveLock;
    ffmpegMutex = new Promise((resolve) => { resolveLock = resolve; });
    await currentLock;

    try {
      console.log(`[FFmpeg] Extracting audio from ${videoPath}...`);
      await new Promise((resolve, reject) => {
        const cmd = `ffmpeg -i "${videoPath}" -vn -ac 1 -ar 16000 -y "${tempAudioPath}"`;
        exec(cmd, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    } finally {
      resolveLock();
    }

    // 2. Upload to GCS
    console.log(`[GCS] Uploading to gs://${gcp.bucketName}/${gcsDestination}...`);
    const storage = new Storage();
    await storage.bucket(gcp.bucketName).upload(tempAudioPath, {
      destination: gcsDestination
    });
    gcsUri = `gs://${gcp.bucketName}/${gcsDestination}`;

    // 3. Transcribe with Speech-to-Text V2 Chirp
    console.log(`[Speech-to-Text] Starting Chirp transcription...`);
    const speechLocation = gcp.speechLocation || 'us-central1';
    const speechClient = new SpeechClient({
      apiEndpoint: `${speechLocation}-speech.googleapis.com`
    });

    const recognizerPath = `projects/${gcp.projectId}/locations/${speechLocation}/recognizers/_`;
    const sttRequest = {
      recognizer: recognizerPath,
      files: [{ uri: gcsUri }],
      config: {
        languageCodes: ['en-US'],
        model: 'chirp_2',
        features: {
          enableWordTimeOffsets: true
        },
        autoDecodingConfig: {}
      },
      recognitionOutputConfig: {
        inlineResponseConfig: {}
      }
    };

    const [operation] = await speechClient.batchRecognize(sttRequest);
    const [sttResponse] = await operation.promise();

    let transcript = '';
    const results = sttResponse.results || {};
    if (results[gcsUri] && results[gcsUri].transcript && results[gcsUri].transcript.results) {
      transcript = results[gcsUri].transcript.results
        .map(r => {
          const alt = r.alternatives[0];
          if (!alt) return '';
          let segmentText = alt.transcript;
          if (alt.words && alt.words.length > 0) {
            const firstWord = alt.words[0];
            const startSec = parseFloat(firstWord.startTime.seconds || 0) + parseFloat(firstWord.startTime.nanos || 0) / 1e9;
            const timeStr = formatSecondsToTimestamp(startSec);
            return `${timeStr} ${segmentText}`;
          }
          return segmentText;
        })
        .filter(Boolean)
        .join(' ');
    }

    if (results[gcsUri] && results[gcsUri].error) {
      throw new Error(`Speech-to-Text failed: ${results[gcsUri].error.message || 'Internal STT error'}`);
    }

    if (!transcript) {
      throw new Error('Transcription returned empty text.');
    }

    return transcript;
  } finally {
    // Clean up local temp file
    if (fs.existsSync(tempAudioPath)) {
      try {
        fs.unlinkSync(tempAudioPath);
      } catch (err) {
        console.error('Error deleting local temp audio file:', err);
      }
    }
    // Clean up GCS staging file
    if (gcsUri) {
      try {
        const storage = new Storage();
        await storage.bucket(gcp.bucketName).file(gcsDestination).delete();
      } catch (err) {
        console.error('Error deleting GCS file:', err);
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
    const gcp = db.gcpConfig || {};
    logMessage('Scanning course structure...');

    // Traverse the course path using processCourseTree
    const courseTree = processCourseTree(path.basename(coursePath), coursePath, null);
    const allItems = [];

    courseTree.sections.forEach(sec => {
      sec.items.forEach(item => {
        const ext = path.extname(item.path).toLowerCase();
        const isEligible = item.type === 'video' ||
                           (item.type === 'text' && (ext === '.md' || ext === '.txt')) ||
                           (item.type === 'html' && (ext === '.html' || ext === '.htm'));
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

    await limitConcurrency(3, itemsToProcess, async (item, index) => {
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
        if (item.type === 'video') {
          const videoTranscriptPath = baseWithoutExt + '.transcript.txt';
          if (fs.existsSync(videoTranscriptPath)) {
            logMessage(`Found existing transcript for "${item.name}". Generating summary...`);
            try {
              const transcript = fs.readFileSync(videoTranscriptPath, 'utf8');
              const summary = await summarizeContent(transcript, 'video', gcp, item.relativePath);
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
              const summary = await summarizeContent(cleanedText, 'video', gcp, item.relativePath);
              
              fs.writeFileSync(videoTranscriptPath, cleanedText, 'utf8');
              fs.writeFileSync(itemSummaryPath, summary, 'utf8');
              
              notesContent = summary;
              hasNotes = true;
            } catch (err) {
              logMessage(`[Error] Failed to process subtitles for "${item.name}": ${err.message}`);
            }
          } else {
            // No subtitles/notes. Try Speech-to-Text if GCP configured
            if (gcp.projectId && gcp.bucketName) {
              logMessage(`No notes or subtitles found for "${item.name}". Running Speech-to-Text (this can take a moment)...`);
              try {
                const transcript = await transcribeVideoWithChirp(item.path, gcp);
                const summary = await summarizeContent(transcript, 'video', gcp, item.relativePath);
                
                fs.writeFileSync(videoTranscriptPath, transcript, 'utf8');
                fs.writeFileSync(itemSummaryPath, summary, 'utf8');
                
                notesContent = summary;
                hasNotes = true;
              } catch (err) {
                logMessage(`[Error] Transcription failed for "${item.name}": ${err.message}`);
              }
            } else {
              logMessage(`[Warning] Skipping "${item.name}" because it has no notes, subtitles, or GCP config.`);
              skippedFiles.push(item.name);
            }
          }
        } else if (item.type === 'text') {
          logMessage(`Reading Markdown content for "${item.name}" and generating notes...`);
          try {
            const content = fs.readFileSync(item.path, 'utf8');
            if (content.trim()) {
              const summary = await summarizeContent(content, 'document', gcp);
              fs.writeFileSync(itemSummaryPath, summary, 'utf8');
              notesContent = summary;
              hasNotes = true;
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
              const summary = await summarizeContent(cleanedText, 'document', gcp);
              fs.writeFileSync(itemSummaryPath, summary, 'utf8');
              notesContent = summary;
              hasNotes = true;
            } else {
              logMessage(`[Warning] Skipping empty HTML file "${item.name}".`);
            }
          } catch (err) {
            logMessage(`[Error] Failed to process HTML file "${item.name}": ${err.message}`);
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

    const location = gcp.location || 'global';
    const ai = new GoogleGenAI({
      enterprise: true,
      project: gcp.projectId,
      location: location,
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

    const synthesisResult = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: synthesisPrompt,
    });

    let masterSummary = synthesisResult.text;
    if (!masterSummary) {
      throw new Error('Master summarization returned empty text.');
    }

    // Append a list of skipped files if any
    if (skippedFiles.length > 0) {
      masterSummary += `\n\n---\n\n> [!NOTE]\n> **Skipped Files:** The following file(s) did not have transcripts, subtitles, or active GCP Speech-to-Text configuration and were omitted from this summary:\n` + 
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

// --- SINGLE VIDEO NOTES GENERATION ENDPOINT ---
// --- SINGLE VIDEO NOTES GENERATION ENDPOINT ---
app.post('/api/video/generate-transcript', async (req, res) => {
  const videoPath = req.body.path;
  if (!videoPath || !fs.existsSync(videoPath)) {
    return res.status(400).send({ error: 'Invalid file path' });
  }

  const gcp = db.gcpConfig || {};
  if (!gcp.projectId) {
    return res.status(400).send({ error: 'GCP Project ID must be configured in Settings.' });
  }

  const ext = path.extname(videoPath).toLowerCase();
  const baseWithoutExt = videoPath.slice(0, -ext.length);
  const transcriptPath = baseWithoutExt + '.transcript.txt';
  const summaryPath = baseWithoutExt + '.summary.md';

  try {
    let transcript = '';

    if (['.html', '.htm'].includes(ext)) {
      if (fs.existsSync(transcriptPath)) {
        transcript = fs.readFileSync(transcriptPath, 'utf8');
      } else {
        const htmlContent = fs.readFileSync(videoPath, 'utf8');
        transcript = cleanHtmlText(htmlContent);
        fs.writeFileSync(transcriptPath, transcript, 'utf8');
      }
      const summary = await summarizeContent(transcript, 'document', gcp);
      fs.writeFileSync(summaryPath, summary, 'utf8');

      return res.send({
        success: true,
        transcript,
        summary
      });
    } else if (['.txt', '.md'].includes(ext) || CODE_EXTENSIONS.includes(ext)) {
      if (fs.existsSync(transcriptPath)) {
        transcript = fs.readFileSync(transcriptPath, 'utf8');
      } else {
        transcript = fs.readFileSync(videoPath, 'utf8');
        fs.writeFileSync(transcriptPath, transcript, 'utf8');
      }
      const summary = await summarizeContent(transcript, 'document', gcp);
      fs.writeFileSync(summaryPath, summary, 'utf8');

      return res.send({
        success: true,
        transcript,
        summary
      });
    }

    // Video files fallback
    let subtitlePath = '';
    if (fs.existsSync(baseWithoutExt + '.vtt')) {
      subtitlePath = baseWithoutExt + '.vtt';
    } else if (fs.existsSync(baseWithoutExt + '.srt')) {
      subtitlePath = baseWithoutExt + '.srt';
    }

    if (fs.existsSync(transcriptPath)) {
      transcript = fs.readFileSync(transcriptPath, 'utf8');
    } else if (subtitlePath) {
      console.log(`[Transcript] Found subtitles for ${videoPath}. Parsing track content...`);
      const subtitleContent = fs.readFileSync(subtitlePath, 'utf8');
      transcript = cleanSubtitleText(subtitleContent);
      fs.writeFileSync(transcriptPath, transcript, 'utf8');
    } else {
      if (!gcp.bucketName) {
        return res.status(400).send({ error: 'GCS Bucket Name must be configured in Settings to run speech-to-text.' });
      }
      transcript = await transcribeVideoWithChirp(videoPath, gcp);
      fs.writeFileSync(transcriptPath, transcript, 'utf8');
    }

    const relPath = getRelativePathFromAbsolute(videoPath);
    const summary = await summarizeContent(transcript, 'video', gcp, relPath);
    fs.writeFileSync(summaryPath, summary, 'utf8');

    res.send({
      success: true,
      transcript,
      summary
    });

  } catch (err) {
    console.error('Error generating transcript/summary:', err);
    res.status(500).send({ error: err.message || 'Failed to generate transcript and summary' });
  }
});

// Chat with video transcript endpoint
app.post('/api/video/chat', async (req, res) => {
  const { path: videoPath, message, history } = req.body;
  if (!videoPath || !fs.existsSync(videoPath)) {
    return res.status(400).send({ error: 'Invalid file path' });
  }
  if (!message) {
    return res.status(400).send({ error: 'Message is required' });
  }

  const gcp = db.gcpConfig || {};
  if (!gcp.projectId) {
    return res.status(400).send({ error: 'GCP Project ID must be configured in Settings.' });
  }

  const ext = path.extname(videoPath);
  const baseWithoutExt = videoPath.slice(0, -ext.length);
  const transcriptPath = baseWithoutExt + '.transcript.txt';

  if (!fs.existsSync(transcriptPath)) {
    return res.status(400).send({ error: 'No transcript available. Please generate AI notes first.' });
  }

  try {
    const transcript = fs.readFileSync(transcriptPath, 'utf8');
    const location = gcp.location || 'global';
    const ai = new GoogleGenAI({
      enterprise: true,
      project: gcp.projectId,
      location: location,
    });

    const isVideo = ['.mp4', '.mkv', '.mov', '.webm', '.avi'].includes(ext.toLowerCase());

    const systemInstruction = `You are an expert AI tutor helping a student study a course.
Below is the ${isVideo ? 'transcript of the video lecture they are currently watching' : 'content of the document they are currently studying'}.
Analyze the content carefully and answer the student's questions based on it.
If the answer is not directly found in the text, you can use your general knowledge to supplement it, but prioritize information from the course material and make sure to clarify when you are adding external context.
Keep your answers clear, educational, and formatting-rich (use markdown, code snippets, lists, bold terms).

Here is the ${isVideo ? 'transcript of the lecture' : 'content of the document'}:
---
${transcript}
---`;

    const contents = [];
    if (history && Array.isArray(history)) {
      history.forEach(item => {
        contents.push({
          role: item.role === 'model' || item.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: item.content }]
        });
      });
    }
    contents.push({
      role: 'user',
      parts: [{ text: message }]
    });

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: contents,
      config: {
        systemInstruction: systemInstruction
      }
    });

    res.send({ response: response.text });
  } catch (err) {
    console.error('Error in video chat:', err);
    res.status(500).send({ error: err.message || 'Failed to get AI response' });
  }
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

  const gcp = db.gcpConfig || {};
  if (!gcp.projectId) {
    return res.status(400).send({ error: 'GCP Project ID must be configured in Settings.' });
  }

  try {
    const summaryFilePath = path.join(coursePath, 'course.summary.md');
    let contextText = '';

    if (fs.existsSync(summaryFilePath)) {
      contextText = fs.readFileSync(summaryFilePath, 'utf8');
    } else {
      // Fallback: search for all generated transcripts and summaries in the course
      const transcripts = [];
      const traverseForContext = (dir) => {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          const fullPath = path.join(dir, item.name);
          if (item.isDirectory()) {
            if (!IGNORE_DIRS.includes(item.name.toLowerCase())) {
              traverseForContext(fullPath);
            }
          } else if (item.isFile()) {
            if (item.name.endsWith('.transcript.txt')) {
              try {
                const text = fs.readFileSync(fullPath, 'utf8');
                if (text.trim()) {
                  transcripts.push(`Lecture: ${item.name.replace('.transcript.txt', '')}\nTranscript:\n${text}`);
                }
              } catch (e) {
                console.error('Error reading transcript', fullPath, e);
              }
            } else if (item.name.endsWith('.summary.md') && item.name !== 'course.summary.md') {
              try {
                const text = fs.readFileSync(fullPath, 'utf8');
                if (text.trim()) {
                  transcripts.push(`Lecture: ${item.name.replace('.summary.md', '')}\nSummary:\n${text}`);
                }
              } catch (e) {
                console.error('Error reading summary', fullPath, e);
              }
            }
          }
        }
      };

      traverseForContext(coursePath);

      if (transcripts.length > 0) {
        contextText = transcripts.join('\n\n');
        if (contextText.length > 200000) {
          contextText = contextText.substring(0, 200000) + '\n\n[Truncated due to length]';
        }
      }
    }

    if (!contextText.trim()) {
      return res.status(400).send({ error: 'No course materials have been transcribed or summarized yet. Please generate AI notes for lectures or generate the Course Summary first.' });
    }

    const location = gcp.location || 'global';
    const ai = new GoogleGenAI({
      enterprise: true,
      project: gcp.projectId,
      location: location,
    });

    const systemInstruction = `You are a master AI tutor helping a student study a complete course.
Below is the consolidated content of the course, which may include the course-level master summary, lecture transcripts, and key summaries.
Use this context to answer the student's questions about the entire course. Explain concepts clearly, relate topics across different lectures, and synthesize information.
If the answer is not found in the course context, you may use your general knowledge, but prioritize the course content and mention when you are adding external knowledge.
Format your responses using clean markdown (bold terms, lists, tables, code blocks).

Here is the course context:
---
${contextText}
---`;

    const contents = [];
    if (history && Array.isArray(history)) {
      history.forEach(item => {
        contents.push({
          role: item.role === 'model' || item.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: item.content }]
        });
      });
    }
    contents.push({
      role: 'user',
      parts: [{ text: message }]
    });

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: contents,
      config: {
        systemInstruction: systemInstruction
      }
    });

    res.send({ response: response.text });
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
app.listen(PORT, () => {
  console.log(`Course Viewer server running on http://localhost:${PORT}`);
});
