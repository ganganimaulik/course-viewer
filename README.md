# Course Viewer & Tracker

A local web application designed to help you organize, play, and track learning progress for downloaded courses. Perfect for cataloging and tracking folders filled with video lectures, PDF documents, HTML webpages, and markdown/text resources.

## Features
- **Auto-scan Directories**: Recursively scans configured folders on your Mac (e.g. `~/Downloads/courses`, `~/Downloads/Mega Downloads`) to build a course catalog.
- **Support for Multiple Media Formats**:
  - Custom HTML5 Video player with subtitle overlay support (translates `.srt` on the fly).
  - Inline PDF Document Viewer.
  - Interactive HTML Article iframe container.
  - Text & Markdown viewer.
- **Progress Tracking**:
  - Tracks specific video playback seconds (remembers where you left off).
  - Highlights active courses on the Dashboard under **Continue Learning**.
  - Provides a global reset and per-course reset functionality (clears bookmarks, read counts, and checklist states).
- **Desktop System Integrations**:
  - **Reveal in Finder**: Instantly highlights the current lesson file in your Mac Finder.
  - **Open in Default App**: Launches the selected file in your system's default viewer (e.g., VLC for unsupported codecs, Acrobat Reader, Chrome, etc.).
- **Modern UI**: Dark-themed, glassmorphic design system using responsive styling and smooth animations.

---

## Tech Stack
- **Frontend**: Vanilla HTML5, CSS3, and JavaScript (SPA architecture).
- **Backend**: Express.js server running on port `3005`.
- **Database**: Local JSON database file (`db.json`) for configuration and progress serialization.
- **Development Tooling**: `nodemon` for auto-restarting the server on file modifications.

---

## Installation & Running Locally

### Prerequisites
- [Node.js](https://nodejs.org) (v14 or higher)

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

### Watching Folders
- By default, the application watches `~/Downloads/courses` and `~/Downloads/Mega Downloads`.
- Navigate to the **Settings** view in the UI to add any custom local directories to scan.
