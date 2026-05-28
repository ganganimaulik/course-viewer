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

---

## Autostart with PM2 (Background Service)

To run the application continuously in the background and ensure it automatically starts when your Mac boots:

### 1. Install PM2 globally
```bash
npm install -g pm2
```

### 2. Start the Application
From the repository root directory, start the server:
```bash
pm2 start server.js --name "course-viewer"
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
- **Check Status:** `pm2 status`
- **View Logs:** `pm2 logs course-viewer`
- **Restart Application:** `pm2 restart course-viewer`
- **Temporarily Stop Application:** `pm2 stop course-viewer`
- **Start/Re-enable Application:** `pm2 start course-viewer`

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

