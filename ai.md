# AI Agent Reference Guide: Course Viewer & Tracker

Welcome, AI Agent! This guide outlines the architecture, data models, APIs, and guidelines for developing on the **Course Viewer & Tracker** application.

---

## 1. Project Overview & Architecture
This application is a local course player and progress tracker. It recursively scans local directories for downloaded courses (videos, PDFs, HTML articles, text, markdown, etc.) and lists them on a modern glassmorphic dashboard.

It consists of two main components:
1. **Express Backend (`server.js`)**: A Node.js server running on port `3005` by default (see PM2 config `ecosystem.config.js`). It scans folders, hosts REST API endpoints, streams media, calls Fireworks AI for LLM features (notes, summaries, chat), and calls a Whisper transcription app deployed on Modal.
2. **SPA Frontend (`public/`)**: A Single Page Application using vanilla HTML5, CSS3, and JavaScript:
   - [index.html](file:///Users/maulik/Documents/GitHub/course-viewer/public/index.html): Layout, sidebar, tabs, viewers (Video, PDF, HTML iframe, Markdown/Code), AI services settings, and chatbot drawer.
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
  "aiConfig": {
    "llmModel": "accounts/fireworks/models/deepseek-v4p1-flash-1017"
  }
}
```
*Note: Write modifications to `db` using `saveDb()` in `server.js` to serialize state. An empty `llmModel` means the default Fireworks model. API keys are never stored in `db.json`.*

---

## 3. API Endpoints Reference
The Express app exposes the following APIs:

### Config & Folders
- `GET /api/config`: Returns the list of watched directories.
- `POST /api/config` `{ path: "/path" }`: Validates and adds a watched directory.
- `POST /api/config/remove` `{ path: "/path" }`: Removes a directory from watches.
- `GET /api/ai-config`: Returns the Fireworks model plus whether Fireworks AI and Modal credentials are configured (never the keys themselves).
- `POST /api/ai-config` `{ llmModel }`: Saves the Fireworks model ID (empty = default).

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

### AI Features
- `GET /api/video/metadata?path=<path>`: Gets transcript (from `<video>.transcript.txt`) and summary (from `<video>.summary.md`) if they exist.
- `POST /api/video/generate-transcript` `{ path }`: Builds the transcript (existing file, subtitles, extracted document text, or Whisper transcription on Modal for videos) and summarizes it with Fireworks AI.
- `POST /api/video/pregenerate-summaries` `{ paths }`: Queues background summary generation for neighboring lessons.
- `POST /api/video/chat` `{ path, message, history }`: Uses the Fireworks model to chat about a lesson's transcript.
- `POST /api/course/chat` `{ courseId, message, history }`: Chatbot for the entire course context.
- `POST /api/course/generate-summary` `{ courseId, force }`: Triggers course summarization.
- `GET /api/course/summary-status?courseId=<id>`: Checks status of summary generation.

---

## 4. AI Services (Fireworks AI & Modal)
- **LLM (Fireworks AI)**: `generateWithFireworks()` in `server.js` streams chat completions from Fireworks' OpenAI-compatible API. It needs `FIREWORKS_API_KEY`, which `server.js` loads from `.env` at startup (see `.env.example`). The model defaults to `DEFAULT_LLM_MODEL` and can be changed in Settings.
- **Transcription (Modal)**: `modal_transcriber.py` defines the `course-viewer-transcriber` Modal app (Whisper large-v3-turbo via faster-whisper on a GPU). `transcribeVideoWithModal()` extracts a mono Opus track with `ffmpeg`, calls `Transcriber.transcribe` through the Modal JS SDK (`modal` npm package), and formats the returned segments as `[MM:SS]` paragraphs.
- Modal credentials come from `~/.modal.toml` (written by `modal token set`) or `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`. Redeploy the app with `npm run modal:deploy` after editing `modal_transcriber.py`.

---

## 5. Coding Conventions & Guidelines

### Backend (`server.js`)
- Do not split `server.js` unless explicitly requested. Keep imports clean.
- Ensure all file paths are handled safely using Node's `path` library.
- Safely escape shells in `exec` calls. Avoid shell injection vulnerabilities.
- The server listens on `127.0.0.1` only, sends no CORS headers, and rejects non-local `Host` headers and cross-site writes. Any endpoint that takes a file or course path must check it with `isInWatchedFolder()`.
- For all writing/updating of progress, ensure `saveDb()` is called afterwards.
- Preserve any existing comments/logic in `server.js`.

### Frontend (`public/app.js`, `public/index.html`, `public/style.css`)
- **Single Page App Architecture**: Do not introduce custom frontend routing libraries. Keep routing inside `switchView(viewId)` in `app.js`.
- **Vanilla CSS**: Follow the modern glassmorphic styling conventions defined in `public/style.css`. Utilize CSS variables (e.g. `--bg-glass`, `--primary`, `--accent`) for theme consistency. Avoid Tailwind CSS unless specifically requested.
- **No Placeholders**: Do not insert broken elements or dummy mock assets. Keep UI interactions complete.

---

## 6. Setup and Development Commands
- Install dependencies: `npm install` (Node 22+; `ffmpeg` is required for transcription)
- Deploy the Modal transcription app: `npm run modal:deploy` (requires the Modal CLI: `pip install modal`)
- you can't Start dev server if port is being used by pm2 already running.
- Run PM2 Daemon: `npm run pm2:start` / `npm run pm2:stop`
- Port: `3005` (localhost:3005)
