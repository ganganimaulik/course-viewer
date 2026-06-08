# AI Agent Reference Guide: Course Viewer & Tracker

Welcome, AI Agent! This guide outlines the architecture, data models, APIs, and guidelines for developing on the **Course Viewer & Tracker** application.

---

## 1. Project Overview & Architecture
This application is a local course player and progress tracker. It recursively scans local directories for downloaded courses (videos, PDFs, HTML articles, text, markdown, etc.) and lists them on a modern glassmorphic dashboard.

It consists of two main components:
1. **Express Backend (`server.js`)**: A Node.js server running on port `3005` by default (see PM2 config `ecosystem.config.js`). It scans folders, hosts REST API endpoints, streams media, and communicates with Google Cloud Platform APIs for Speech-to-Text and Gemini AI models.
2. **SPA Frontend (`public/`)**: A Single Page Application using vanilla HTML5, CSS3, and JavaScript:
   - [index.html](file:///Users/maulik/Documents/GitHub/course-viewer/public/index.html): Layout, sidebar, tabs, viewers (Video, PDF, HTML iframe, Markdown/Code), GCP settings form, and chatbot drawer.
   - [style.css](file:///Users/maulik/Documents/GitHub/course-viewer/public/style.css): Modern, premium glassmorphic dark-theme design system.
   - [app.js](file:///Users/maulik/Documents/GitHub/course-viewer/public/app.js): Application state, SPA view routing, API calls, event handlers, keyboard shortcuts, transcript/chat workflows, and media controls.

---

## 2. Data Storage (`db.json`)
The application saves config and progress state in a local JSON database: [db.json](file:///Users/maulik/Documents/GitHub/course-viewer/db.json).

### Database Schema
```json
{
  "folders": [
    "/absolute/path/to/courses/folder-1",
    "/absolute/path/to/courses/folder-2"
  ],
  "progress": {
    "/absolute/path/to/courses/folder-1/Course_Name/Lesson_1.mp4": {
      "lastStudied": "2026-06-08T03:00:00.000Z",
      "completed": true,
      "skipped": false,
      "percent": 100,
      "currentTime": 124.5,
      "duration": 124.5
    }
  },
  "gcpConfig": {
    "projectId": "gcp-project-id",
    "bucketName": "gcs-bucket-name",
    "location": "global",
    "speechLocation": "us-central1"
  }
}
```
*Note: Write modifications to `db` using `saveDb()` in `server.js` to serialize state.*

---

## 3. API Endpoints Reference
The Express app exposes the following APIs:

### Config & Folders
- `GET /api/config`: Returns the list of watched directories.
- `POST /api/config` `{ path: "/path" }`: Validates and adds a watched directory.
- `POST /api/config/remove` `{ path: "/path" }`: Removes a directory from watches.
- `GET /api/gcp-config`: Returns GCP config settings.
- `POST /api/gcp-config`: Saves GCP settings (`projectId`, `bucketName`, `location`, `speechLocation`).

### Courses & Lessons
- `GET /api/courses`: Scans configured folders and returns a list of parsed courses containing sections, items, and merged progress. Sorted by `lastStudied` (most recent first) then alphabetical.
- `GET /api/progress`: Gets all progress entries.
- `POST /api/progress` `{ filePath, currentTime, duration, completed, skipped }`: Updates progress metrics for a file.
- `POST /api/progress/reset`: Clears all progress.
- `POST /api/courses/reset` `{ courseId }`: Resets progress for a specific course (id is base64url of its absolute path).
- `POST /api/courses/complete` `{ courseId }`: Marks all lessons in a course as completed.

### File Delivery
- `GET /api/video?path=<path>`: Streams video file (supports range/partial content requests).
- `GET /api/subtitle?path=<path>`: Reads `.srt` or `.vtt` file (converts SRT subtitles to WebVTT on-the-fly).
- `GET /api/file?path=<path>`: Serves files with appropriate headers (PDF, HTML, images, code, or plain text).

### Mac System Commands
- `POST /api/open-in-finder` `{ path }`: Opens Finder with the target file highlighted (`open -R`).
- `POST /api/open-in-system` `{ path }`: Opens the file in its default macOS app (`open`).

### GCP & AI Features
- `GET /api/video/metadata?path=<path>`: Gets transcript (from `<video>.transcript.txt`) and summary (from `<video>.summary.md`) if they exist.
- `POST /api/video/generate-transcript` `{ videoPath }`: Runs Speech-to-Text transcription.
- `POST /api/video/chat` `{ videoPath, prompt, chatHistory }`: Uses Gemini model to chat about a video's transcript.
- `POST /api/course/chat` `{ courseId, prompt, chatHistory }`: Chatbot for the entire course context.
- `POST /api/course/generate-summary` `{ courseId, force }`: Triggers course summarization.
- `GET /api/course/summary-status?courseId=<id>`: Checks status of summary generation.

---

## 4. Coding Conventions & Guidelines

### Backend (`server.js`)
- Do not split `server.js` unless explicitly requested. Keep imports clean.
- Ensure all file paths are handled safely using Node's `path` library.
- Safely escape shells in `exec` calls. Avoid shell injection vulnerabilities.
- For all writing/updating of progress, ensure `saveDb()` is called afterwards.
- Preserve any existing comments/logic in `server.js`.

### Frontend (`public/app.js`, `public/index.html`, `public/style.css`)
- **Single Page App Architecture**: Do not introduce custom frontend routing libraries. Keep routing inside `switchView(viewId)` in `app.js`.
- **Vanilla CSS**: Follow the modern glassmorphic styling conventions defined in `public/style.css`. Utilize CSS variables (e.g. `--bg-glass`, `--primary`, `--accent`) for theme consistency. Avoid Tailwind CSS unless specifically requested.
- **No Placeholders**: Do not insert broken elements or dummy mock assets. Keep UI interactions complete.

---

## 5. Setup and Development Commands
- Install dependencies: `npm install`
- you can't Start dev server if port is being used by pm2 already running.
- Run PM2 Daemon: `npm run pm2:start` / `npm run pm2:stop`
- Port: `3005` (localhost:3005)
