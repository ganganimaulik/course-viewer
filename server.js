const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { exec } = require('child_process');

const app = express();
const PORT = 3005;
const DB_FILE = path.join(__dirname, 'db.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Database
let db = {
  folders: [
    '/Users/maulik/Downloads/courses',
    '/Users/maulik/Downloads/Mega Downloads'
  ],
  progress: {}
};

if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    db = JSON.parse(raw);
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
          const newSectionName = currentSectionName === 'General' ? item.name : `${currentSectionName} / ${item.name}`;
          traverse(fullPath, newSectionName);
        } else if (item.isFile()) {
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
          } else if (['.vtt', '.srt', '.png', '.jpg', '.jpeg', '.gif', '.DS_Store'].includes(ext)) {
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
          if (prog.completed) {
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
  const { filePath, currentTime, duration, completed } = req.body;
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
  if (completed !== undefined) {
    prog.completed = completed;
    if (completed) {
      prog.percent = 100;
      if (prog.duration && prog.currentTime === undefined) {
        prog.currentTime = prog.duration;
      }
    }
  }

  if (prog.duration && prog.currentTime !== undefined) {
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

// Serves PDF, HTML, or plain text
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
  if (ext === '.pdf') contentType = 'application/pdf';
  else if (ext === '.html' || ext === '.htm') contentType = 'text/html';
  else if (ext === '.txt') contentType = 'text/plain';
  else if (ext === '.md') contentType = 'text/markdown';

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

// Start Server
app.listen(PORT, () => {
  console.log(`Course Viewer server running on http://localhost:${PORT}`);
});
