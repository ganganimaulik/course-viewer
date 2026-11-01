# Course Viewer & Tracker

A local web application designed to help you organize, play, and track learning progress for downloaded courses. Perfect for cataloging and tracking folders filled with video lectures, PDF documents, HTML webpages, and markdown/text resources.

## Features
- **Auto-scan Directories**: Recursively scans configured folders on your Mac (e.g. `~/Downloads/courses`, `~/Downloads/Mega Downloads`) to build a course catalog.
- **Support for Multiple Media Formats**:
  - Custom HTML5 Video player with subtitle overlay support (translates `.srt` on the fly). Audio lessons (`.mp3`, `.m4a`, `.ogg`, etc.) play in the same player.
  - `.ts` videos (MPEG transport streams, e.g. HLS downloads) are copied into an MP4 with ffmpeg the first time they play. The copies live in `~/Library/Caches/course-viewer` and the least recently watched are deleted past 4 GB.
  - PDF viewer ([PDF.js](https://mozilla.github.io/pdf.js/), loaded on first use) with page navigation and zoom. For search or printing, use **Open in App**.
  - Word documents (`.docx`) shown as readable pages.
  - Interactive HTML Article iframe container.
  - Text & Markdown viewer.
- **Progress Tracking**:
  - Tracks specific video playback seconds (remembers where you left off).
  - Remembers how far you've scrolled in lesson pages and Word documents, and which page of a PDF you're on, and marks them complete when you reach the end (a page that fits on screen, once you scroll or click in it).
  - Highlights active courses on the Dashboard under **Continue Learning**.
  - Logs real study time per day: while a video or audio lesson plays, or while a page, PDF or document is open and you've been active in the last 5 minutes. The Dashboard shows today's time, your streak, progress toward a weekly goal (set in **Settings**) and a 26-week heatmap. History starts the first time you study with this version.
  - Measures every video and audio lesson's length with ffprobe in the background, so course cards show total length and time left at your playback speed (which is remembered).
  - Provides a global reset and per-course reset functionality (clears bookmarks, read counts, and checklist states).
- **AI Notes & Chat**:
  - Transcribes lectures without subtitles using Whisper running on [Modal](https://modal.com), and saves the timings as a `.vtt` caption file next to the lecture.
  - Shows transcripts with clickable timestamps that follow along as the lecture plays. Lectures transcribed before captions were saved can be transcribed again from the Transcript tab.
  - Generates lesson notes, course-wide study guides, and answers questions with [Fireworks AI](https://fireworks.ai) models. Course chat answers from the passages most relevant to your question and cites lecture timestamps you can click.
- **Search**: One search box (press **/** anywhere) across lesson names, transcripts, AI notes and the text of lesson pages in every course. Results open the lesson, and lectures start where the match is spoken. Text from lesson pages is cached in `~/Library/Caches/course-viewer`.
- **Desktop System Integrations**:
  - **Reveal in Finder**: Instantly highlights the current lesson file in your Mac Finder.
  - **Open in Default App**: Launches the selected file in your system's default viewer (e.g., VLC for unsupported codecs, Acrobat Reader, Chrome, etc.).
- **Modern UI**: Dark-themed, glassmorphic design system using responsive styling and smooth animations.

---

## Tech Stack
- **Frontend**: Vanilla HTML5, CSS3, and JavaScript (SPA architecture).
- **Backend**: Express.js server running on port `3005`.
- **Database**: Local JSON database file (`db.json`) for configuration and progress serialization.
- **AI Services**: Fireworks AI (LLM) and a Whisper transcription app deployed on Modal (`modal_transcriber.py`).
- **Development Tooling**: `nodemon` for auto-restarting the server on file modifications.

---

## Installation & Running Locally

### Prerequisites
- [Node.js](https://nodejs.org) (v22 or higher)
- [ffmpeg](https://ffmpeg.org) (`brew install ffmpeg`) to play `.ts` videos and transcribe lectures
- For AI notes: the Modal CLI (`pip install modal`)

### Setup
1. Clone the repository or download the source files.
2. Install the necessary dependencies:
   ```bash
   npm install
   ```
3. Start the application:
   ```bash
   npm start
   ```
4. Open the application in your browser:
   [http://localhost:3005](http://localhost:3005)
   (Opening `public/index.html` as a file won't work: the server only answers pages it serves itself.)

The server only accepts requests from this Mac: it listens on `127.0.0.1`, rejects requests made by other websites, and only serves files inside your watched folders. Downloaded lesson pages and Markdown can't run scripts inside the app; embedded players such as Vimeo are unaffected.

### AI Notes Setup (Fireworks AI + Modal)
1. Create a `.env` file from the template and add your [Fireworks API key](https://app.fireworks.ai/settings/users/api-keys):
   ```bash
   cp .env.example .env
   ```
2. Authenticate the Modal CLI (this saves a token to `~/.modal.toml`, which the server also uses):
   ```bash
   modal token set --token-id <id> --token-secret <secret>
   ```
3. Deploy the transcription app to your Modal workspace (re-run after editing `modal_transcriber.py`):
   ```bash
   npm run modal:deploy
   ```
4. Restart the server. **Settings → AI Services** shows whether both services are detected and lets you change the Fireworks model.

### Watching Folders
- By default, the application watches `~/Downloads/courses` and `~/Downloads/Mega Downloads`.
- Navigate to the **Settings** view in the UI to add any custom local directories to scan.

---

## Autostart with PM2 (Background Service)

To run the application continuously in the background and ensure it automatically starts when your Mac boots:

### 1. Install PM2 globally
```bash
npm install -g pm2
```

### 2. Start the Application
From the repository root directory, start the server using the PM2 ecosystem configuration:
```bash
pm2 start ecosystem.config.js
# Or via npm script:
npm run pm2:start
```

### 3. Configure PM2 Startup
To configure PM2 to run automatically when the system boots:
```bash
pm2 startup
```
This command will output a specific `sudo` command. Copy and run that command in your terminal to enable the boot configuration.

### 4. Save the Process List
Save the active process list so it is restored on boot:
```bash
pm2 save
```

### 5. Managing the Service
- **Check Status:** `pm2 status` or `pm2 show course-viewer`
- **View Logs:** `pm2 logs course-viewer`
- **Restart Application:** `pm2 restart course-viewer` (or `npm run pm2:restart`)
- **Temporarily Stop Application:** `pm2 stop course-viewer` (or `npm run pm2:stop`)
- **Delete Application from Registry:** `pm2 delete course-viewer` (or `npm run pm2:delete`)

### 6. Disable PM2 Autostart Completely
If you want to remove the application from PM2 and disable autostart on system boot:
1. Remove the application from the PM2 registry and save the empty list:
   ```bash
   pm2 delete course-viewer
   pm2 save
   ```
2. Disable the PM2 boot hook:
   ```bash
   pm2 unstartup
   ```
   *(This command will output a specific `sudo` command. Copy and run that command in your terminal to completely remove the startup agent from macOS)*.

