const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { exec } = require('child_process');
const { SpeechClient } = require('@google-cloud/speech').v2;
const { Storage } = require('@google-cloud/storage');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = 3005;
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

app.post('/api/video/generate-transcript', async (req, res) => {
  const videoPath = req.body.path;
  if (!videoPath || !fs.existsSync(videoPath)) {
    return res.status(400).send({ error: 'Invalid file path' });
  }

  const gcp = db.gcpConfig || {};
  if (!gcp.projectId || !gcp.bucketName) {
    return res.status(400).send({ error: 'GCP Project ID and GCS Bucket Name must be configured in Settings.' });
  }

  const ext = path.extname(videoPath);
  const baseWithoutExt = videoPath.slice(0, -ext.length);
  const transcriptPath = baseWithoutExt + '.transcript.txt';
  const summaryPath = baseWithoutExt + '.summary.md';

  const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const tempAudioPath = path.join(__dirname, `temp_audio_${uniqueId}.wav`);
  const gcsDestination = `course-viewer-transcripts/audio_${uniqueId}.wav`;
  let gcsUri = null;

  try {
    // 1. Extract audio locally
    console.log(`[FFmpeg] Extracting audio from ${videoPath}...`);
    await new Promise((resolve, reject) => {
      const cmd = `ffmpeg -i "${videoPath}" -vn -ac 1 -ar 16000 -y "${tempAudioPath}"`;
      exec(cmd, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

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
        .map(r => r.alternatives[0] ? r.alternatives[0].transcript : '')
        .filter(Boolean)
        .join(' ');
    }

    if (results[gcsUri] && results[gcsUri].error) {
      throw new Error(`Speech-to-Text failed: ${results[gcsUri].error.message || 'Internal STT error'}`);
    }

    if (!transcript) {
      throw new Error('Transcription returned empty text.');
    }

    // 4. Summarize with Vertex AI (Gemini 3.5 Flash) using new GoogleGenAI SDK
    console.log(`[Vertex AI] Summarizing with gemini-3.5-flash (location: ${gcp.location || 'global'})...`);
    const location = gcp.location || 'global';
    const ai = new GoogleGenAI({
      enterprise: true,
      project: gcp.projectId,
      location: location,
    });

    const prompt = `
You are an AI assistant helping a student review course lecture material.
Below is the raw transcript of a lecture. Please perform the following:
1. Provide a concise, high-level summary of the main topics discussed (3-5 sentences).
2. Create a bulleted list of key takeaways, concepts, or terms explained in the lecture.
3. Formulate 2-3 review questions based on the content.

Format the output nicely in Markdown.

Here is the transcript:
---
${transcript}
---
`;

    const genResult = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
    });

    const summary = genResult.text;

    if (!summary) {
      throw new Error('Summarization returned empty text.');
    }

    // 5. Save files locally
    fs.writeFileSync(transcriptPath, transcript, 'utf8');
    fs.writeFileSync(summaryPath, summary, 'utf8');

    res.send({
      success: true,
      transcript,
      summary
    });

  } catch (err) {
    console.error('Error generating transcript/summary:', err);
    res.status(500).send({ error: err.message || 'Failed to generate transcript and summary' });
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
});

// Start Server
app.listen(PORT, () => {
  console.log(`Course Viewer server running on http://localhost:${PORT}`);
});
