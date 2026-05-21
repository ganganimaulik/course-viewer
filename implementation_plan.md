# Course Player & Tracker Implementation Plan

A local web application that automatically scans the Mac `Downloads` folder for video courses, parses their structure into sections and lectures, streams the videos, and tracks watch progress (where you left off, last studied time, completion percentage, and active courses).

## User Review Required

> [!IMPORTANT]
> The server runs locally and serves videos directly from your `/Users/maulik/Downloads` folder. The application is built using a local Node.js Express backend and a premium Vanilla CSS frontend.
>
> **Accessing Downloads**: The Node.js server requires access to your home directory (`/Users/maulik/Downloads`) to scan and read video files. This runs locally on your machine and never uploads your files.

## Open Questions

- **Video Formats**: The system will scan for `.mp4`, `.mkv`, `.mov`, and `.webm` files. Let me know if you have courses in other formats (e.g. `.avi`, `.flv`).
- **Autoplay Behavior**: When a video finishes, the player will automatically countdown 5 seconds and start the next video. Let me know if you'd prefer to pause instead.

## Proposed Changes

We will create a new project in `/Users/maulik/.gemini/antigravity/scratch/course-player`.

---

### Backend Component

This component handles scanning the Downloads directory, serving the video stream with Range header support (for scrubbing), and storing playback progress.

#### [NEW] [package.json](file:///Users/maulik/.gemini/antigravity/scratch/course-player/package.json)
- Configures dependencies: `express` (web server), `cors` (cross-origin resource sharing), `nodemon` (development auto-restart).
- Sets up run scripts for starting the server.

#### [NEW] [server.js](file:///Users/maulik/.gemini/antigravity/scratch/course-player/server.js)
- **Downloads Directory Scanner**:
  - Recursively scans `/Users/maulik/Downloads` (up to a depth of 3 levels).
  - Groups directories containing video files into "Courses".
  - Recursively structures folders inside courses as "Sections" and files as "Lectures".
- **Progress Storage**:
  - Saves course progress details to a local `progress.json` file.
  - Progress contains: total duration, watched duration, completed status, last watched timestamp, and the exact second where you left off.
- **REST Endpoints**:
  - `GET /api/courses`: Scans the filesystem, joins with progress data, and returns the structured list of courses.
  - `POST /api/progress`: Saves/updates progress for a specific video path.
  - `GET /api/video`: Streams a video file by path, handling HTTP Range requests so the browser's video player can scrub back and forth.

---

### Frontend Component

A beautiful, premium Single Page Application (SPA) dashboard styled with modern Glassmorphism aesthetics and custom controls.

#### [NEW] [frontend/index.html](file:///Users/maulik/.gemini/antigravity/scratch/course-player/frontend/index.html)
- Standard HTML5 framework with modern typography loaded from Google Fonts (Inter & Outfit).
- Navigation header showing system statistics (total study time, active courses, completed courses).
- Tabbed layout or View controller supporting:
  - **Dashboard View**: Displays "Actively Watching" list with progress rings, "Recently Played" quick resume cards, and a grid of "All Available Courses".
  - **Course Workspace View**: Two-column layout containing a sidebar navigation list of all sections/lectures (with indicators for completed/in-progress) and the main workspace showing the video player or course summary.

#### [NEW] [frontend/style.css](file:///Users/maulik/.gemini/antigravity/scratch/course-player/frontend/style.css)
- Custom design tokens using HSL colors for dark/light neutral surfaces and vibrant gradient accents (deep purple to electric cyan).
- Glassmorphism accents using `backdrop-filter: blur` and translucent borders.
- Sleek interactive transitions: hover scaling, progress bar filling animations, and custom scrollbars.
- Layout using CSS Grid and Flexbox for fully responsive design down to tablet sizes.

#### [NEW] [frontend/app.js](file:///Users/maulik/.gemini/antigravity/scratch/course-player/frontend/app.js)
- Single Page App router (renders appropriate screens dynamically without page reload).
- Core State manager: holds course catalog, progress logs, currently playing course, and playback status.
- Custom Video Controller:
  - Listens to native video tag events (`timeupdate`, `loadedmetadata`, `ended`).
  - Auto-resumes from last saved position (`currentTime`).
  - Throttle-saves progress to backend (every 5 seconds) to prevent lag.
  - Custom speed menu (from 0.5x up to 3.0x).
  - Next Video Autoplay countdown when the current video finishes.

---

## Verification Plan

### Automated Tests
- Start the Express server locally and verify that the API `/api/courses` successfully scans and groups the folders in `/Users/maulik/Downloads`.
- Run curl checks on `/api/video` with Range requests to ensure correct streaming headers (`Accept-Ranges`, `Content-Range`, `Content-Length`, `206 Partial Content`).

### Manual Verification
- Launch the application, navigate to the local address (e.g. `http://localhost:3000`), and check the Dashboard for correctness.
- Play a video, pause it, verify that progress was saved, and check that refreshing or reopening the course starts playing exactly where you left off.
- Fast-forward to the end of a video and ensure that it triggers the countdown and plays the next lesson in sequence.
