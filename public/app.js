// --- API CONFIGURATION ---
const API_BASE = window.location.protocol === 'file:' ? 'http://localhost:3005' : '';

// File types listed under the Lessons tab; all other types are listed under Resources
const LESSON_TYPES = ['video', 'audio', 'pdf', 'html', 'docx', 'text'];
// File types that can get AI notes and chat
const AI_NOTES_TYPES = ['video', 'audio', 'pdf', 'html', 'docx', 'text', 'code'];

// Audio plays in the same player as video, with the same progress tracking
function isMediaItem(item) {
  return !!item && (item.type === 'video' || item.type === 'audio');
}

// --- APPLICATION STATE ---
let state = {
  courses: [],
  config: { folders: [] },
  currentCourse: null,
  currentSection: null,
  currentItem: null,
  view: 'dashboard',
  playbackRate: 1.0,
  progressSaveInterval: null,
  lastSavedTime: 0,
  autoplayTimer: null,
  currentWorkspaceTab: 'lessons',
  sidebarAutoCollapsed: false,
  chatHistory: [],
  courseChatHistory: [],
  generatingTranscripts: {}
};

// Toast notification function
function showToast(message) {
  const toast = document.getElementById('toast-notification');
  const toastMsg = document.getElementById('toast-message');
  toastMsg.textContent = message;
  toast.classList.add('active');
  setTimeout(() => {
    toast.classList.remove('active');
  }, 3000);
}

// Format duration to MM:SS or HH:MM:SS
function formatTime(seconds) {
  if (isNaN(seconds)) return "00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  
  if (h > 0) {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// Convert absolute path to a safe display path (e.g. replacing home dir with ~)
function displayPath(fullPath) {
  return fullPath.replace('/Users/maulik', '~');
}

// --- INIT APP ---
document.addEventListener('DOMContentLoaded', () => {
  initVideoPlayerEvents();
  refreshCatalog(true);
  
  // Restore sidebar state
  if (localStorage.getItem('sidebar-collapsed') === 'true') {
    const sidebar = document.getElementById('app-sidebar');
    if (sidebar) sidebar.classList.add('collapsed');
    
    const titleText = 'Expand Sidebar';
    const brandBtn = document.getElementById('brand-toggle-btn');
    const navBtn = document.getElementById('sidebar-toggle-btn');
    if (brandBtn) brandBtn.setAttribute('title', titleText);
    if (navBtn) navBtn.setAttribute('title', titleText);
  }
  
  // Close speed and shortcuts dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.speed-container')) {
      const speedMenu = document.getElementById('speed-dropdown-menu');
      if (speedMenu) speedMenu.classList.remove('active');
    }
    if (!e.target.closest('.shortcuts-container')) {
      const shortcutsMenu = document.getElementById('shortcuts-dropdown-menu');
      if (shortcutsMenu) shortcutsMenu.classList.remove('active');
    }
  });

  initKeyboardShortcuts();

  // Intercept clicks on timestamp links
  document.addEventListener('click', (e) => {
    const anchor = e.target.closest('a');
    if (anchor) {
      const href = anchor.getAttribute('href');
      if (href && href.startsWith('timestamp:')) {
        e.preventDefault();
        handleTimestampClick(href);
      }
    }
  });
});

// Click-to-seek timestamp handler
function handleTimestampClick(href) {
  const urlPart = href.substring('timestamp:'.length);
  const [encodedPath, secondsStr] = urlPart.split('#');
  const relativePath = decodeURIComponent(encodedPath);
  const seconds = parseFloat(secondsStr);

  console.log('Timestamp clicked:', relativePath, seconds);

  if (!state.currentCourse) return;

  let foundItem = null;
  let foundSection = null;

  for (const section of state.currentCourse.sections) {
    const item = section.items.find(i => i.relativePath === relativePath);
    if (item) {
      foundItem = item;
      foundSection = section;
      break;
    }
  }

  if (!foundItem) {
    const basename = relativePath.split('/').pop();
    for (const section of state.currentCourse.sections) {
      const item = section.items.find(i => i.name === basename);
      if (item) {
        foundItem = item;
        foundSection = section;
        break;
      }
    }
  }

  if (foundItem) {
    switchWorkspaceTab('lessons');

    const isSameItem = state.currentItem && state.currentItem.path === foundItem.path;
    if (isSameItem) {
      const video = document.getElementById('main-video-player');
      if (video) {
        video.currentTime = seconds;
        video.play().catch(err => console.log('Play failed:', err));
      }
    } else {
      state.pendingSeekTime = seconds;
      selectItem(foundItem, foundSection);
    }
  } else {
    console.error('Could not find course item matching:', relativePath);
  }
}

// --- ROUTING / VIEW SWITCHER ---
function switchView(viewId) {
  state.view = viewId;
  localStorage.setItem('current-view', viewId);
  
  // Pause video player if we leave workspace
  if (viewId !== 'workspace') {
    const video = document.getElementById('main-video-player');
    if (video && !video.paused) {
      video.pause();
    }
    cancelAutoplay();
  }

  // Update Nav Active States
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  const activeNav = document.getElementById(`nav-${viewId}`);
  if (activeNav) activeNav.classList.add('active');

  // Update View Visibilities
  document.querySelectorAll('.content-view').forEach(view => {
    view.classList.remove('active');
  });
  document.getElementById(`view-${viewId}`).classList.add('active');

  // Refresh Views
  if (viewId === 'dashboard') {
    renderDashboard();
  } else if (viewId === 'courses') {
    renderFullCatalog();
  } else if (viewId === 'settings') {
    renderSettings();
  }
}

function restoreLastView() {
  const savedView = localStorage.getItem('current-view');
  if (!savedView) return;

  if (savedView === 'workspace') {
    const savedCourseId = localStorage.getItem('current-course-id');
    if (savedCourseId) {
      const course = state.courses.find(c => c.id === savedCourseId);
      if (course) {
        const savedItemPath = localStorage.getItem('current-item-path');
        openCourse(savedCourseId, savedItemPath);
        return;
      }
    }
  }

  if (['dashboard', 'courses', 'settings'].includes(savedView)) {
    switchView(savedView);
  }
}

// --- FETCH & DATA SYNC ---
async function refreshCatalog(isInitialLoad = false) {
  const refreshBtn = document.getElementById('refresh-courses-btn');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = `Scanning...`;
  }
  
  try {
    // Fetch watch folders config
    const configRes = await fetch(`${API_BASE}/api/config`);
    state.config = await configRes.json();

    // Fetch AI services configuration
    try {
      const aiRes = await fetch(`${API_BASE}/api/ai-config`);
      state.aiConfig = await aiRes.json();
    } catch (e) {
      console.warn('Error loading AI config:', e);
    }
    
    // Fetch courses with merged progress
    const coursesRes = await fetch(`${API_BASE}/api/courses`);
    state.courses = await coursesRes.json();

    renderDashboard();
    renderFullCatalog();
    renderSettings();

    // If we have an active course open, update its state from the refreshed courses list
    if (state.currentCourse) {
      const updatedCourse = state.courses.find(c => c.id === state.currentCourse.id);
      if (updatedCourse) {
        state.currentCourse = updatedCourse;
        // Re-point the open item at its refreshed object too, so its progress isn't stale (e.g. after a reset)
        if (state.currentItem) {
          for (const sec of updatedCourse.sections) {
            const freshItem = sec.items.find(i => i.path === state.currentItem.path);
            if (freshItem) {
              if (state.videoItem === state.currentItem) state.videoItem = freshItem;
              state.currentItem = freshItem;
              state.currentSection = sec;
              break;
            }
          }
          updateHeaderActionBtn();
        }
        document.getElementById('workspace-course-progress').textContent = `${updatedCourse.progressPercent}% Completed`;
        const watchBtn = document.getElementById('btn-watch-course');
        if (watchBtn) {
          watchBtn.style.display = updatedCourse.progressPercent === 100 ? 'none' : '';
        }
        renderActiveWorkspaceOutline();
      }
    }

    if (isInitialLoad) {
      restoreLastView();
    }
  } catch (err) {
    console.error('Error fetching data:', err);
    showToast('Failed to connect to local backend');
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        Refresh Folders
      `;
    }
  }
}

// --- VIEW GENERATION & RENDERING ---

// Calculate & display stats + resume grid + courses list on Dashboard
function renderDashboard() {
  // 1. Statistics
  let totalWatchedSeconds = 0;
  let activeCount = 0;
  let completedCount = 0;
  let recentFiles = [];

  state.courses.forEach(course => {
    const isActive = (course.completedItems > 0 || course.hasProgress) && course.completedItems < course.totalItems;
    if (isActive) {
      activeCount++;
    }
    
    course.sections.forEach(sec => {
      sec.items.forEach(item => {
        if (item.progress) {
          if (isMediaItem(item) && item.progress.currentTime) {
            totalWatchedSeconds += item.progress.currentTime;
          }
          if (item.progress.completed || item.progress.skipped) {
            completedCount++;
          }
          recentFiles.push({
            ...item,
            courseTitle: course.title,
            courseId: course.id
          });
        }
      });
    });
  });

  document.getElementById('stat-hours').textContent = `${(totalWatchedSeconds / 3600).toFixed(1)}h`;
  document.getElementById('stat-active-courses').textContent = activeCount;
  document.getElementById('stat-completed-files').textContent = completedCount;

  // Set welcome message username/detail
  const hour = new Date().getHours();
  let greet = "Good evening";
  if (hour < 12) greet = "Good morning";
  else if (hour < 18) greet = "Good afternoon";
  document.getElementById('welcome-msg').textContent = `${greet}! You've completed ${completedCount} lectures across your local downloads folder.`;

  // 2. Resume Learning Grid (Sort files by lastStudied descending, show max 3)
  recentFiles.sort((a, b) => new Date(b.progress.lastStudied) - new Date(a.progress.lastStudied));
  const resumeGrid = document.getElementById('resume-grid');
  resumeGrid.innerHTML = '';
  
  const resumeContainer = document.getElementById('resume-container');
  if (recentFiles.length === 0) {
    resumeContainer.style.display = 'none';
  } else {
    resumeContainer.style.display = 'block';
    const topThree = recentFiles.slice(0, 3);
    topThree.forEach(item => {
      const card = document.createElement('div');
      card.className = 'resume-card';
      card.onclick = () => resumePlayback(item);

      const percent = item.progress.percent || 0;
      let progressLabel = '';
      if (item.progress.skipped) {
        progressLabel = 'Skipped';
      } else if (isMediaItem(item)) {
        progressLabel = `${formatTime(item.progress.currentTime)} / ${formatTime(item.progress.duration)} (${percent}%)`;
      } else {
        progressLabel = item.progress.completed ? 'Completed' : 'Started';
      }

      const dateStudied = getRelativeTime(new Date(item.progress.lastStudied));

      card.innerHTML = `
        <div class="resume-card-header">
          <span class="resume-type-badge ${item.type}">${item.type}</span>
          <span class="resume-date">${dateStudied}</span>
        </div>
        <div class="resume-title-box">
          <div class="resume-course-title">${escapeHtml(item.courseTitle)}</div>
          <div class="resume-file-title" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
        </div>
        <div class="resume-progress-container">
          <div class="resume-progress-text">
            <span>Progress</span>
            <span>${progressLabel}</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width: ${percent}%"></div>
          </div>
        </div>
      `;
      resumeGrid.appendChild(card);
    });
  }

  // 3. Courses catalog grid (Dashboard view shows all)
  const coursesGrid = document.getElementById('courses-grid');
  coursesGrid.innerHTML = '';

  // Setup filter source list
  const filterSource = document.getElementById('catalog-filter-source');
  const selectedSource = filterSource.value;
  filterSource.innerHTML = '<option value="all">All Source Paths</option>';
  state.config.folders.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = displayPath(f);
    if (f === selectedSource) opt.selected = true;
    filterSource.appendChild(opt);
  });

  renderCourseList(state.courses, coursesGrid, 'catalog-search', 'catalog-filter-status', 'catalog-filter-source');
}

// Render Course Catalog full list
function renderFullCatalog() {
  const fullGrid = document.getElementById('full-courses-grid');
  fullGrid.innerHTML = '';
  renderCourseList(state.courses, fullGrid, 'full-catalog-search', 'full-catalog-filter-status');
}

// Core card rendering loop shared by Dashboard & Full Catalog
function renderCourseList(coursesList, targetContainer, searchInputId, statusFilterId, sourceFilterId = null) {
  targetContainer.innerHTML = '';

  const searchQuery = document.getElementById(searchInputId).value.toLowerCase().trim();
  const statusFilter = document.getElementById(statusFilterId).value;
  const sourceFilter = sourceFilterId ? document.getElementById(sourceFilterId).value : 'all';

  let filtered = coursesList.filter(c => {
    // 1. Search Query Match
    const matchesSearch = c.title.toLowerCase().includes(searchQuery) || c.path.toLowerCase().includes(searchQuery);
    
    // 2. Status Match
    let matchesStatus = true;
    if (statusFilter === 'active') {
      matchesStatus = (c.completedItems > 0 || c.hasProgress) && c.completedItems < c.totalItems;
    } else if (statusFilter === 'completed') {
      matchesStatus = c.completedItems === c.totalItems && c.totalItems > 0;
    } else if (statusFilter === 'notstarted') {
      matchesStatus = c.completedItems === 0 && !c.hasProgress;
    }

    // 3. Source Folder Match
    let matchesSource = true;
    if (sourceFilter !== 'all') {
      matchesSource = c.sourceRoot === sourceFilter;
    }

    return matchesSearch && matchesStatus && matchesSource;
  });

  if (filtered.length === 0) {
    targetContainer.innerHTML = `
      <div class="empty-catalog-state">
        <svg class="empty-catalog-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>
        <h3>No courses found</h3>
        <p>Try modifying your search query or check folders config in Settings.</p>
      </div>
    `;
    return;
  }

  filtered.forEach(c => {
    const card = document.createElement('div');
    card.className = 'course-card';
    card.onclick = () => openCourse(c.id);

    // SVG Circular Progress
    const radius = 20;
    const circ = 2 * Math.PI * radius;
    const strokeOffset = circ - (c.progressPercent / 100) * circ;
    
    // Icon counters
    let videos = 0, audios = 0, pdfs = 0, htmls = 0, docs = 0, texts = 0, others = 0;
    c.sections.forEach(sec => {
      sec.items.forEach(i => {
        if (i.type === 'video') videos++;
        else if (i.type === 'audio') audios++;
        else if (i.type === 'pdf') pdfs++;
        else if (i.type === 'html') htmls++;
        else if (i.type === 'docx') docs++;
        else if (i.type === 'text') texts++;
        else others++;
      });
    });

    const folderBadge = displayPath(c.sourceRoot).split('/').pop();

    card.innerHTML = `
      <div class="course-card-top">
        <div class="badge-and-reset">
          <span class="course-source-badge" title="${escapeHtml(c.sourceRoot)}">${escapeHtml(folderBadge)}</span>
          <div class="card-actions-row">
            ${(c.completedItems > 0 || c.hasProgress) ? `
              <button class="card-reset-btn" title="Reset Course Progress">
                <svg class="card-reset-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
              </button>
            ` : ''}
            ${c.completedItems < c.totalItems ? `
              <button class="card-watch-btn" title="Mark Course as Watched">
                <svg class="card-watch-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3"/></svg>
              </button>
            ` : ''}
          </div>
        </div>
        <div class="course-progress-ring">
          <svg>
            <defs>
              <linearGradient id="grad-ring" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#8b5cf6" />
                <stop offset="100%" stop-color="#06b6d4" />
              </linearGradient>
            </defs>
            <circle class="ring-bg" cx="25" cy="25" r="${radius}"></circle>
            <circle class="ring-fill" cx="25" cy="25" r="${radius}" 
              stroke-dasharray="${circ}" stroke-dashoffset="${strokeOffset}"></circle>
          </svg>
          <div class="ring-percent">${c.progressPercent}%</div>
        </div>
      </div>
      <div class="course-title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</div>
      <div class="course-meta">
        <div class="course-meta-row">
          <svg class="meta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>
          <span>${videos} Video Lectures</span>
        </div>
        ${pdfs > 0 ? `
        <div class="course-meta-row">
          <svg class="meta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span>${pdfs} PDF Documents</span>
        </div>` : ''}
        ${htmls > 0 ? `
        <div class="course-meta-row">
          <svg class="meta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          <span>${htmls} HTML Webpages</span>
        </div>` : ''}
        ${audios > 0 ? `
        <div class="course-meta-row">
          <svg class="meta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          <span>${audios} Audio Lessons</span>
        </div>` : ''}
        ${docs > 0 ? `
        <div class="course-meta-row">
          <svg class="meta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="8 12 9.5 18 12 14 14.5 18 16 12"/></svg>
          <span>${docs} Word Documents</span>
        </div>` : ''}
      </div>
    `;
    // Bind actions in JS rather than inline onclick strings, which break on titles containing quotes
    const resetBtn = card.querySelector('.card-reset-btn');
    if (resetBtn) resetBtn.onclick = (e) => confirmResetCourseProgressCard(e, c.id, c.title);
    const watchBtn = card.querySelector('.card-watch-btn');
    if (watchBtn) watchBtn.onclick = (e) => confirmWatchCourseProgressCard(e, c.id, c.title);
    targetContainer.appendChild(card);
  });
}

function filterCourses() {
  renderDashboard();
}

function filterFullCatalog() {
  renderFullCatalog();
}

// Relative times generator
function getRelativeTime(date) {
  const diffMs = new Date() - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays} days ago`;
}

// --- ================== WORKSPACE VIEW ACTIONS ================== ---

// Clicked Resume from Dashboard card
function resumePlayback(item) {
  // Find full course object
  const course = state.courses.find(c => c.id === item.courseId);
  if (!course) return;
  
  // Open on the tab that lists this item (the last-used tab may be Summary or the other list), and
  // let openCourse select the course's own item object rather than this dashboard copy
  localStorage.setItem('current-workspace-tab', LESSON_TYPES.includes(item.type) ? 'lessons' : 'resources');
  openCourse(item.courseId, item.path);
}

// Open Course outline view
function openCourse(courseId, restoreItemPath = null) {
  const course = state.courses.find(c => c.id === courseId);
  if (!course) return;

  state.currentCourse = course;
  // Nothing is open yet in this course; an item left over from the previous course would otherwise
  // reappear (with its breadcrumbs) when switching sidebar tabs
  state.currentItem = null;
  state.currentSection = null;
  state.courseChatHistory = [];
  renderCourseChatMessages(); // Clear the previous course's conversation from the panel
  
  const chatPanel = document.getElementById('course-chat-panel');
  if (chatPanel) chatPanel.style.display = 'none';
  const toggleBtn = document.getElementById('btn-toggle-course-chat');
  if (toggleBtn) toggleBtn.style.display = 'none';

  localStorage.setItem('current-course-id', courseId);
  if (!restoreItemPath) {
    localStorage.removeItem('current-item-path');
  }
  switchView('workspace');

  document.getElementById('workspace-course-title').textContent = course.title;
  document.getElementById('workspace-course-progress').textContent = `${course.progressPercent}% Completed`;
  
  const watchBtn = document.getElementById('btn-watch-course');
  if (watchBtn) {
    watchBtn.style.display = course.progressPercent === 100 ? 'none' : '';
  }
  
  // Restore tab
  const storedTab = localStorage.getItem('current-workspace-tab') || 'lessons';
  switchWorkspaceTab(storedTab);

  if (storedTab !== 'course-summary') {
    // Load blank state viewer or restored item
    if (restoreItemPath) {
      let foundItem = null;
      let foundSection = null;
      course.sections.forEach(sec => {
        const it = sec.items.find(i => i.path === restoreItemPath);
        if (it) {
          foundItem = it;
          foundSection = sec;
        }
      });

      if (foundItem) {
        selectItem(foundItem, foundSection);
      } else {
        showViewerPanel('blank');
        document.getElementById('file-actions-bar').style.display = 'none';
      }
    } else {
      showViewerPanel('blank');
      document.getElementById('file-actions-bar').style.display = 'none';
    }
  }

  // Set breadcrumbs initial (a restored item has already set its own section crumb)
  document.getElementById('crumb-course').textContent = 'Dashboard';
  if (!state.currentItem) {
    document.getElementById('crumb-section').textContent = course.title;
  }
  if (storedTab !== 'course-summary' && !restoreItemPath) {
    document.getElementById('crumb-item').textContent = '';
    document.getElementById('crumb-item').classList.remove('active');
  }
}

// Renders Accordion Directory outline for Lessons (videos, pdf, html, text)
function renderCourseOutline() {
  const outlineList = document.getElementById('course-outline-list');
  if (!outlineList) return;
  outlineList.innerHTML = '';

  const searchQuery = document.getElementById('outline-search').value.toLowerCase().trim();

  state.currentCourse.sections.forEach(section => {
    let itemsFiltered = section.items.filter(item => {
      const isCore = LESSON_TYPES.includes(item.type);
      const matchesSearch = item.name.toLowerCase().includes(searchQuery);
      return isCore && matchesSearch;
    });

    if (itemsFiltered.length === 0) return; // Hide section if no items match

    const acc = document.createElement('div');
    acc.className = 'section-accordion';
    acc.id = `sec-acc-${section.name.replace(/\s+/g, '_')}`;

    // Header Trigger
    const trigger = document.createElement('button');
    trigger.className = 'section-trigger';
    trigger.onclick = () => acc.classList.toggle('collapsed');

    // Folder Icon Mapping
    let sectionIconSVG = `
      <svg class="section-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
    `;
    if (section.name === 'General') {
      sectionIconSVG = `
        <svg class="section-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>
      `;
    }

    trigger.innerHTML = `
      <div class="section-title-wrapper">
        ${sectionIconSVG}
        <span class="section-title-text" title="${escapeHtml(section.name)}">${escapeHtml(section.name)}</span>
      </div>
      <svg class="section-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    `;
    acc.appendChild(trigger);

    // Section Content
    const content = document.createElement('div');
    content.className = 'section-content';

    itemsFiltered.forEach(item => {
      const itemRow = document.createElement('div');
      itemRow.className = 'outline-item';
      if (state.currentItem && state.currentItem.path === item.path) {
        itemRow.classList.add('active');
      }
      itemRow.dataset.path = item.path;
      
      // Determine file icon
      let typeIcon = '';
      if (item.type === 'video') {
        typeIcon = '<svg class="outline-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
      } else if (item.type === 'pdf') {
        typeIcon = '<svg class="outline-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      } else if (item.type === 'html') {
        typeIcon = '<svg class="outline-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
      } else if (item.type === 'audio') {
        typeIcon = '<svg class="outline-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
      } else if (item.type === 'docx') {
        typeIcon = '<svg class="outline-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="8 12 9.5 18 12 14 14.5 18 16 12"/></svg>';
      } else if (item.type === 'text') {
        typeIcon = '<svg class="outline-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>';
      } else {
        typeIcon = '<svg class="outline-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      }

      // Checkbox checked/skipped state
      let checkedClass = '';
      if (item.progress) {
        if (item.progress.completed) checkedClass = 'checked';
        else if (item.progress.skipped) checkedClass = 'skipped';
      }

      itemRow.innerHTML = `
        <div class="item-check-checkbox ${checkedClass}">
          <svg class="check-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          <svg class="skip-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>
        </div>
        ${typeIcon}
        <span class="outline-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
      `;
      // Bound in JS: an inline onclick string breaks on paths containing quotes (e.g. "What's Next.mp4")
      itemRow.querySelector('.item-check-checkbox').addEventListener('click', (e) => toggleItemComplete(e, item.path));

      // Entire row click (except checking) selects the item to view
      itemRow.addEventListener('click', (e) => {
        if (!e.target.closest('.item-check-checkbox')) {
          selectItem(item, section);
        }
      });

      content.appendChild(itemRow);
    });

    acc.appendChild(content);
    outlineList.appendChild(acc);
  });
}

// Renders Accordion Directory outline for Resources (images, code, other files)
function renderCourseResources() {
  const resourceList = document.getElementById('course-resources-list');
  if (!resourceList) return;
  resourceList.innerHTML = '';

  const searchQuery = document.getElementById('outline-search').value.toLowerCase().trim();

  state.currentCourse.sections.forEach(section => {
    let itemsFiltered = section.items.filter(item => {
      const isResource = ['image', 'code', 'other'].includes(item.type);
      const matchesSearch = item.name.toLowerCase().includes(searchQuery);
      return isResource && matchesSearch;
    });

    if (itemsFiltered.length === 0) return; // Hide section if no items match

    const acc = document.createElement('div');
    acc.className = 'section-accordion';
    acc.id = `sec-res-acc-${section.name.replace(/\s+/g, '_')}`;

    // Header Trigger
    const trigger = document.createElement('button');
    trigger.className = 'section-trigger';
    trigger.onclick = () => acc.classList.toggle('collapsed');

    // Folder Icon Mapping
    let sectionIconSVG = `
      <svg class="section-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
    `;
    if (section.name === 'General') {
      sectionIconSVG = `
        <svg class="section-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>
      `;
    }

    trigger.innerHTML = `
      <div class="section-title-wrapper">
        ${sectionIconSVG}
        <span class="section-title-text" title="${escapeHtml(section.name)}">${escapeHtml(section.name)}</span>
      </div>
      <svg class="section-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    `;
    acc.appendChild(trigger);

    // Section Content
    const content = document.createElement('div');
    content.className = 'section-content';

    itemsFiltered.forEach(item => {
      const itemRow = document.createElement('div');
      itemRow.className = 'outline-item';
      if (state.currentItem && state.currentItem.path === item.path) {
        itemRow.classList.add('active');
      }
      itemRow.dataset.path = item.path;
      
      // Determine file icon
      let typeIcon = '';
      if (item.type === 'image') {
        typeIcon = '<svg class="outline-item-icon image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
      } else if (item.type === 'code') {
        typeIcon = '<svg class="outline-item-icon code" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
      } else {
        typeIcon = '<svg class="outline-item-icon other" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      }

      // Checkbox checked/skipped state
      let checkedClass = '';
      if (item.progress) {
        if (item.progress.completed) checkedClass = 'checked';
        else if (item.progress.skipped) checkedClass = 'skipped';
      }

      itemRow.innerHTML = `
        <div class="item-check-checkbox ${checkedClass}">
          <svg class="check-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          <svg class="skip-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>
        </div>
        ${typeIcon}
        <span class="outline-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
      `;
      itemRow.querySelector('.item-check-checkbox').addEventListener('click', (e) => toggleItemComplete(e, item.path));

      // Entire row click selects the item to view
      itemRow.addEventListener('click', (e) => {
        if (!e.target.closest('.item-check-checkbox')) {
          selectItem(item, section);
        }
      });

      content.appendChild(itemRow);
    });

    acc.appendChild(content);
    resourceList.appendChild(acc);
  });
}

function switchWorkspaceTab(tabName) {
  if (tabName !== 'lessons' && tabName !== 'resources' && tabName !== 'course-summary') return;
  state.currentWorkspaceTab = tabName;
  localStorage.setItem('current-workspace-tab', tabName);

  const tabLessons = document.getElementById('tab-lessons');
  const tabResources = document.getElementById('tab-resources');
  const tabCourseSummary = document.getElementById('tab-course-summary');
  
  const listLessons = document.getElementById('course-outline-list');
  const listResources = document.getElementById('course-resources-list');
  const listSummaryInfo = document.getElementById('course-summary-sidebar-info');
  const searchInput = document.getElementById('outline-search');

  if (searchInput) searchInput.value = '';

  // Toggle outline sidebar scroll lists
  if (listLessons) listLessons.style.display = tabName === 'lessons' ? 'block' : 'none';
  if (listResources) listResources.style.display = tabName === 'resources' ? 'block' : 'none';
  if (listSummaryInfo) listSummaryInfo.style.display = tabName === 'course-summary' ? 'block' : 'none';

  // Toggle active tab buttons styling
  if (tabLessons) {
    if (tabName === 'lessons') tabLessons.classList.add('active');
    else tabLessons.classList.remove('active');
  }
  if (tabResources) {
    if (tabName === 'resources') tabResources.classList.add('active');
    else tabResources.classList.remove('active');
  }
  if (tabCourseSummary) {
    if (tabName === 'course-summary') tabCourseSummary.classList.add('active');
    else tabCourseSummary.classList.remove('active');
  }

  // Toggle outline search visibility / text
  if (searchInput) {
    if (tabName === 'lessons') {
      searchInput.style.display = 'block';
      searchInput.placeholder = 'Search lectures...';
    } else if (tabName === 'resources') {
      searchInput.style.display = 'block';
      searchInput.placeholder = 'Search resources...';
    } else {
      searchInput.style.display = 'none';
    }
  }

  if (tabName === 'course-summary') {
    // Clear playback tracking intervals/overrides
    if (state.progressSaveInterval) {
      clearInterval(state.progressSaveInterval);
      state.progressSaveInterval = null;
    }
    const video = document.getElementById('main-video-player');
    if (video && !video.paused) {
      video.pause();
    }
    cancelAutoplay();

    // Show course summary in the main viewer panel
    showViewerPanel('course-summary');
    
    // Set breadcrumbs
    document.getElementById('crumb-section').textContent = state.currentCourse.title;
    document.getElementById('crumb-item').textContent = 'Course Summary';
    document.getElementById('crumb-item').classList.add('active');
    document.getElementById('file-actions-bar').style.display = 'none';

    loadCourseSummary();
  } else {
    renderActiveWorkspaceOutline();
    
    // If the outline tab was switched, and there was an active lesson selected, restore its display
    if (state.currentItem) {
      document.getElementById('file-actions-bar').style.display = 'flex';
      showViewerPanel(state.currentItem.type);
      document.getElementById('crumb-section').textContent = state.currentSection.name;
      document.getElementById('crumb-item').textContent = state.currentItem.name;
      document.getElementById('crumb-item').classList.add('active');
    } else {
      showViewerPanel('blank');
      document.getElementById('file-actions-bar').style.display = 'none';
      document.getElementById('crumb-section').textContent = state.currentCourse.title;
      document.getElementById('crumb-item').textContent = '';
      document.getElementById('crumb-item').classList.remove('active');
    }
  }
}

function renderActiveWorkspaceOutline() {
  if (state.currentWorkspaceTab === 'lessons') {
    renderCourseOutline();
  } else {
    renderCourseResources();
  }
}

function filterCourseOutline() {
  renderActiveWorkspaceOutline();
}

// Update the header action button state based on the current active item progress
function updateHeaderActionBtn() {
  const actionBtn = document.getElementById('btn-toggle-complete');
  const skipBtn = document.getElementById('btn-toggle-skip');
  if (!state.currentItem) return;

  const isCompleted = state.currentItem.progress && state.currentItem.progress.completed;
  const isSkipped = state.currentItem.progress && state.currentItem.progress.skipped;

  if (actionBtn) {
    if (isCompleted) {
      actionBtn.classList.add('completed');
      actionBtn.querySelector('span').textContent = 'Completed';
    } else {
      actionBtn.classList.remove('completed');
      actionBtn.querySelector('span').textContent = 'Mark Complete';
    }
  }

  if (skipBtn) {
    if (isSkipped) {
      skipBtn.classList.add('skipped');
      skipBtn.querySelector('span').textContent = 'Skipped';
    } else {
      skipBtn.classList.remove('skipped');
      skipBtn.querySelector('span').textContent = 'Skip Lesson';
    }
  }
}

// Select item to load in viewer panel
function selectItem(item, section = null) {
  // Clear any active playback timer loops
  if (state.progressSaveInterval) {
    clearInterval(state.progressSaveInterval);
    state.progressSaveInterval = null;
  }
  cancelAutoplay();

  // Pause video player if it exists and is playing, saving its position now: loading the next video
  // drops the queued pause event
  const mainVideo = document.getElementById('main-video-player');
  if (mainVideo && !mainVideo.paused) {
    mainVideo.pause();
    saveVideoProgress(true);
  }

  state.currentItem = item;
  localStorage.setItem('current-item-path', item.path);
  if (section) {
    state.currentSection = section;
  } else {
    // Traverse currentCourse sections to find the parent section
    state.currentCourse.sections.forEach(s => {
      if (s.items.some(i => i.path === item.path)) {
        state.currentSection = s;
      }
    });
  }

  // Active state class toggle in outline (matched by path, since file names repeat across sections)
  document.querySelectorAll('.outline-item').forEach(el => {
    el.classList.toggle('active', el.dataset.path === item.path);
  });

  // Load breadcrumbs
  document.getElementById('crumb-section').textContent = state.currentSection.name;
  document.getElementById('crumb-item').textContent = item.name;
  document.getElementById('crumb-item').classList.add('active');

  // Enable/Show top actions bar
  updateHeaderActionBtn();
  document.getElementById('file-actions-bar').style.display = 'flex';

  // Toggle based on file type
  showViewerPanel(item.type);

  if (isMediaItem(item)) {
    loadVideoPlayer(item);
  } else if (item.type === 'pdf') {
    const iframe = document.getElementById('pdf-frame');
    iframe.src = `${API_BASE}/api/file?path=${encodeURIComponent(item.path)}`;
    saveItemStarted(item);
  } else if (item.type === 'html') {
    const iframe = document.getElementById('html-frame');
    iframe.src = `${API_BASE}/api/file?path=${encodeURIComponent(item.path)}`;
    saveItemStarted(item);
  } else if (item.type === 'docx') {
    const iframe = document.getElementById('html-frame');
    iframe.src = `${API_BASE}/api/docx?path=${encodeURIComponent(item.path)}`;
    saveItemStarted(item);
  } else if (item.type === 'text') {
    loadTextViewer(item);
  } else if (item.type === 'image') {
    const imgElement = document.getElementById('image-view-element');
    imgElement.src = `${API_BASE}/api/file?path=${encodeURIComponent(item.path)}`;
    saveItemStarted(item);
  } else if (item.type === 'code') {
    loadTextViewer(item);
  } else {
    document.getElementById('other-file-name').textContent = item.name;
    document.getElementById('other-file-ext').textContent = item.extension;
  }

  // AI sidebar support for eligible types
  const btnToggleSidebar = document.getElementById('btn-toggle-ai-sidebar');
  const extraSidebar = document.getElementById('video-extra-sidebar');

  if (AI_NOTES_TYPES.includes(item.type)) {
    if (btnToggleSidebar) btnToggleSidebar.style.display = 'flex';
    if (extraSidebar) {
      const isCollapsed = localStorage.getItem('video-extra-sidebar-collapsed') !== 'false';
      if (isCollapsed) {
        extraSidebar.classList.add('collapsed');
      } else {
        extraSidebar.classList.remove('collapsed');
      }
    }
    loadVideoMetadata(item);
  } else {
    if (btnToggleSidebar) btnToggleSidebar.style.display = 'none';
    if (extraSidebar) {
      extraSidebar.classList.add('collapsed');
    }
  }
}

// Toggle visible containers inside viewport
function showViewerPanel(type) {
  const panels = {
    blank: 'viewer-blank',
    video: 'viewer-video-container',
    audio: 'viewer-video-container',
    pdf: 'viewer-pdf-container',
    html: 'viewer-html-container',
    docx: 'viewer-html-container',
    text: 'viewer-text-container',
    image: 'viewer-image-container',
    code: 'viewer-text-container',
    other: 'viewer-other-container',
    'course-summary': 'viewer-course-summary-container'
  };

  const targetPanelId = panels[type];

  Object.keys(panels).forEach(key => {
    const panelId = panels[key];
    const el = document.getElementById(panelId);
    if (!el) return;

    if (panelId === targetPanelId) {
      el.style.display = ''; // Clear inline override, letting CSS define display style
      if (panelId === 'viewer-blank') {
        el.classList.add('active');
      }
    } else {
      el.style.display = 'none';
      if (panelId === 'viewer-blank') {
        el.classList.remove('active');
      }
    }
  });
}

// --- VIDEO PLAYER LOGIC & EVENTS ---
function initVideoPlayerEvents() {
  const video = document.getElementById('main-video-player');
  const playBtn = document.getElementById('video-play-btn');
  const slider = document.getElementById('video-progress-slider');
  
  video.addEventListener('click', () => {
    togglePlay();
  });

  video.addEventListener('play', () => {
    playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    cancelAutoplay(); // Replaying after the end shouldn't jump to the next lesson mid-video
    startProgressInterval();
    
    // Auto collapse sidebar when video is playing
    const sidebar = document.getElementById('app-sidebar');
    if (sidebar && !sidebar.classList.contains('collapsed')) {
      setSidebarState(true);
      state.sidebarAutoCollapsed = true;
    }
  });

  video.addEventListener('pause', () => {
    playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    stopProgressInterval();
    saveVideoProgress(true); // Save progress instantly on pause
    
    // Auto expand sidebar if it was auto-collapsed
    if (state.sidebarAutoCollapsed) {
      setSidebarState(false);
      state.sidebarAutoCollapsed = false;
    }
  });

  video.addEventListener('timeupdate', () => {
    // Update slider position
    if (video.duration) {
      const pct = (video.currentTime / video.duration) * 100;
      slider.value = pct;
      document.getElementById('video-current-time').textContent = formatTime(video.currentTime);
    }
  });

  video.addEventListener('loadedmetadata', () => {
    setMediaStatus(null);
    document.getElementById('video-total-duration').textContent = formatTime(video.duration);
    
    // Set speed rate
    video.playbackRate = state.playbackRate;
    document.getElementById('video-speed-btn').textContent = `${state.playbackRate.toFixed(2)}x`;

    // Seek to target or last currentTime position
    if (state.pendingSeekTime !== undefined && state.pendingSeekTime !== null) {
      video.currentTime = state.pendingSeekTime;
      state.pendingSeekTime = null;
      video.play().catch(e => console.log("Play failed:", e));
    } else if (state.currentItem && state.currentItem.progress && state.currentItem.progress.currentTime) {
      // If the video has already been completed, start it from the beginning (0) so the user can watch it again
      // instead of immediately triggering the ended event and auto-advancing/skipping.
      const isCompleted = state.currentItem.progress.completed;
      video.currentTime = isCompleted ? 0 : state.currentItem.progress.currentTime;
    }
  });

  video.addEventListener('ended', () => {
    stopProgressInterval();
    saveVideoProgress(true, true); // Save as completed
    triggerAutoplayCountdown();
    
    // Auto expand sidebar if it was auto-collapsed
    if (state.sidebarAutoCollapsed) {
      setSidebarState(false);
      state.sidebarAutoCollapsed = false;
    }
  });

  // Decoding failures after loading starts land here; failed loads land on the <source> (see loadVideoPlayer)
  video.addEventListener('error', () => {
    if (state.videoItem) showMediaError(state.videoItem);
  });

  video.addEventListener('enterpictureinpicture', () => {
    showToast('Picture-in-Picture active');
  });

  video.addEventListener('leavepictureinpicture', () => {
    showToast('Returned to main player');
  });

  // Initialize Volume UI
  updateVolumeUI();
}

function loadVideoPlayer(item) {
  const video = document.getElementById('main-video-player');
  // Remember which item the player holds: its pause event can fire after another item is selected
  state.videoItem = item;
  
  // Clear tracks and sources
  video.innerHTML = '';
  
  // Set video source
  const source = document.createElement('source');
  source.src = `${API_BASE}/api/video?path=${encodeURIComponent(item.path)}`;
  // A source that fails to load reports it here, not on the <video>
  source.addEventListener('error', () => showMediaError(item));
  video.appendChild(source);

  // Audio has no picture, so show what's playing where it would be
  document.getElementById('audio-artwork').style.display = item.type === 'audio' ? 'flex' : 'none';
  document.getElementById('audio-artwork-title').textContent = item.name;
  setMediaStatus(item.remux ? 'Converting this video so the browser can play it (first time only)...' : null);

  // If subtitle track is present
  if (item.subtitlePath) {
    const track = document.createElement('track');
    track.src = `${API_BASE}/api/subtitle?path=${encodeURIComponent(item.subtitlePath)}`;
    track.kind = 'captions';
    track.srclang = 'en';
    track.label = 'English';
    track.default = true;
    video.appendChild(track);
  }

  video.load();
  video.play().catch(e => console.log("Autoplay blocked by browser. User gesture required."));
}

// Message over the player: a spinner while a video is converted, or a playback error with a way out
function setMediaStatus(message, isError = false) {
  const overlay = document.getElementById('media-status-overlay');
  overlay.style.display = message ? 'flex' : 'none';
  if (!message) return;
  document.getElementById('media-status-text').textContent = message;
  document.getElementById('media-status-spinner').style.display = isError ? 'none' : '';
  document.getElementById('media-status-open-btn').style.display = isError ? '' : 'none';
}

function showMediaError(item) {
  if (state.videoItem !== item) return; // An earlier lesson's late error
  setMediaStatus(item.remux
    ? "This video couldn't be converted for the browser."
    : "This file can't be played in the browser.", true);
}

function togglePlay() {
  const video = document.getElementById('main-video-player');
  if (video.paused) {
    video.play();
  } else {
    video.pause();
  }
}

function toggleMute() {
  const video = document.getElementById('main-video-player');
  video.muted = !video.muted;
  if (!video.muted && video.volume === 0) {
    video.volume = 0.5; // restore to 50% if volume was 0 when unmuting
  }
  updateVolumeUI();
}

function onVolumeSliderChange() {
  const video = document.getElementById('main-video-player');
  const slider = document.getElementById('video-volume-slider');
  video.volume = slider.value;
  video.muted = (slider.value == 0);
  updateVolumeUI();
}

function updateVolumeUI() {
  const video = document.getElementById('main-video-player');
  const slider = document.getElementById('video-volume-slider');
  const volumeIcon = document.getElementById('volume-icon');
  
  if (slider) {
    slider.value = video.muted ? 0 : video.volume;
  }
  
  if (volumeIcon) {
    if (video.muted || video.volume === 0) {
      volumeIcon.innerHTML = '<line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>';
    } else {
      volumeIcon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>';
    }
  }
}

function toggleShortcutsMenu() {
  const menu = document.getElementById('shortcuts-dropdown-menu');
  if (menu) menu.classList.toggle('active');
}

async function togglePictureInPicture() {
  const video = document.getElementById('main-video-player');
  if (!video) return;
  
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled) {
      await video.requestPictureInPicture();
    } else {
      showToast('Picture-in-Picture is not supported in this browser.');
    }
  } catch (err) {
    console.error('PiP Error:', err);
    showToast('Failed to toggle Picture-in-Picture');
  }
}

function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ignore when typing in input/textarea/contenteditable fields. Sliders and checkboxes don't count:
    // the seek and volume sliders keep focus after use, which would otherwise disable every shortcut
    const active = document.activeElement;
    if (active && (
      (active.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(active.type)) ||
      active.tagName === 'TEXTAREA' ||
      active.tagName === 'SELECT' ||
      active.isContentEditable
    )) {
      return;
    }

    // Only run shortcut actions if viewing the workspace and currently loaded item is a video
    if (state.view !== 'workspace' || !isMediaItem(state.currentItem)) {
      return;
    }

    const video = document.getElementById('main-video-player');
    if (!video) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 10);
        break;
      case 'ArrowRight':
        e.preventDefault();
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
        break;
      case 'ArrowUp':
        e.preventDefault();
        {
          const newVol = Math.min(1.0, video.volume + 0.05);
          video.volume = newVol;
          video.muted = false;
          updateVolumeUI();
        }
        break;
      case 'ArrowDown':
        e.preventDefault();
        {
          const newVol = Math.max(0.0, video.volume - 0.05);
          video.volume = newVol;
          video.muted = (newVol === 0);
          updateVolumeUI();
        }
        break;
      case '[':
        e.preventDefault();
        {
          const newRate = Math.max(0.1, state.playbackRate - 0.1);
          setPlaybackRate(newRate);
          showToast(`Speed: ${newRate.toFixed(2)}x`);
        }
        break;
      case ']':
        e.preventDefault();
        {
          const newRate = Math.min(16.0, state.playbackRate + 0.1);
          setPlaybackRate(newRate);
          showToast(`Speed: ${newRate.toFixed(2)}x`);
        }
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        toggleFullscreen();
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        toggleMute();
        break;
      case 'p':
      case 'P':
        e.preventDefault();
        togglePictureInPicture();
        break;
    }
  });
}

function onVideoSliderChange() {
  const video = document.getElementById('main-video-player');
  const slider = document.getElementById('video-progress-slider');
  if (video.duration) {
    const targetSec = (slider.value / 100) * video.duration;
    video.currentTime = targetSec;
  }
}

function toggleSpeedMenu() {
  document.getElementById('speed-dropdown-menu').classList.toggle('active');
}

function setPlaybackRate(rate) {
  state.playbackRate = rate;
  const video = document.getElementById('main-video-player');
  video.playbackRate = rate;
  
  document.getElementById('video-speed-btn').textContent = `${rate.toFixed(2)}x`;
  document.getElementById('speed-dropdown-menu').classList.remove('active');
  
  // Highlight active speed item in menu
  document.querySelectorAll('.speed-menu button').forEach(btn => {
    btn.classList.remove('active');
    if (parseFloat(btn.textContent) === rate) {
      btn.classList.add('active');
    }
  });
}

function toggleFullscreen() {
  const wrapper = document.getElementById('viewer-video-container');
  if (!document.fullscreenElement) {
    wrapper.requestFullscreen().catch(err => console.log(err));
  } else {
    document.exitFullscreen();
  }
}

// Send progress update to backend
async function saveVideoProgress(force = false, isCompleted = false) {
  const video = document.getElementById('main-video-player');
  // Save against the video's own item, not state.currentItem: the selection may already have moved
  // to another item (e.g. a PDF) when this runs, or while the request is in flight
  const item = state.videoItem;
  if (!video.duration || !item) return;

  const now = video.currentTime;
  const timeDiff = Math.abs(now - state.lastSavedTime);

  // Send update if force is true or 5 seconds elapsed
  if (force || timeDiff >= 5 || isCompleted) {
    state.lastSavedTime = now;
    
    try {
      const res = await fetch(`${API_BASE}/api/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: item.path,
          currentTime: now,
          duration: video.duration,
          completed: isCompleted ? true : undefined
        })
      });
      const data = await res.json();
      
      // Sync local courses progress values
      syncCourseProgressMap(item.path, data);

      // Update item progress model locally
      item.progress = data;

      // Update the header action button state
      updateHeaderActionBtn();
    } catch (err) {
      console.error('Error saving progress:', err);
    }
  }
}

function startProgressInterval() {
  if (state.progressSaveInterval) clearInterval(state.progressSaveInterval);
  state.progressSaveInterval = setInterval(() => {
    saveVideoProgress();
  }, 5000);
}

function stopProgressInterval() {
  if (state.progressSaveInterval) {
    clearInterval(state.progressSaveInterval);
    state.progressSaveInterval = null;
  }
}

// Sync local states
function syncCourseProgressMap(path, progressObj) {
  let finishedCountChanged = false;
  
  state.courses.forEach(c => {
    c.sections.forEach(sec => {
      sec.items.forEach(item => {
        if (item.path === path) {
          const wasFinished = !!(item.progress && (item.progress.completed || item.progress.skipped));
          const isFinishedNow = !!(progressObj && (progressObj.completed || progressObj.skipped));
          
          item.progress = progressObj;
          
          if (wasFinished !== isFinishedNow) {
            finishedCountChanged = true;
          }
        }
      });
    });
  });

  if (finishedCountChanged) {
    // Recompute total completed files / course percentages
    recomputeTotalProgress();
    // Re-render active workspace outline to update checkboxes
    renderActiveWorkspaceOutline();
  }
}

function recomputeTotalProgress() {
  state.courses.forEach(c => {
    let totalItems = 0;
    let completedItems = 0;
    let hasProgress = false;
    c.sections.forEach(sec => {
      sec.items.forEach(item => {
        totalItems++;
        if (item.progress) {
          if (item.progress.completed || item.progress.skipped) completedItems++;
          if (item.progress.lastStudied) hasProgress = true;
        }
      });
    });
    c.totalItems = totalItems;
    c.completedItems = completedItems;
    c.progressPercent = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;
    c.hasProgress = hasProgress;
  });

  // Re-render sidebar stats
  let totalFinished = 0;
  let activeCount = 0;
  state.courses.forEach(c => {
    totalFinished += c.completedItems;
    const isActive = (c.completedItems > 0 || c.hasProgress) && c.completedItems < c.totalItems;
    if (isActive) activeCount++;
  });
  
  document.getElementById('stat-completed-files').textContent = totalFinished;
  document.getElementById('stat-active-courses').textContent = activeCount;

  if (state.currentCourse) {
    const updated = state.courses.find(c => c.id === state.currentCourse.id);
    document.getElementById('workspace-course-progress').textContent = `${updated.progressPercent}% Completed`;
    const watchBtn = document.getElementById('btn-watch-course');
    if (watchBtn) {
      watchBtn.style.display = updated.progressPercent === 100 ? 'none' : '';
    }
  }
}

// --- TEXT / DOCUMENT VIEWER LOGIC ---
async function loadTextViewer(item) {
  const textPre = document.getElementById('text-pre-content');
  const textMarkdown = document.getElementById('text-markdown-content');

  if (textPre) {
    textPre.style.display = 'none';
    textPre.textContent = 'Loading content...';
  }
  if (textMarkdown) {
    textMarkdown.style.display = 'none';
    textMarkdown.innerHTML = '';
  }

  try {
    const res = await fetch(`${API_BASE}/api/file?path=${encodeURIComponent(item.path)}`);
    const txt = await res.text();
    
    const ext = item.name.split('.').pop().toLowerCase();
    
    if (ext === 'md') {
      if (textMarkdown) {
        textMarkdown.innerHTML = parseMarkdown(txt);
        processAlerts(textMarkdown);
        if (typeof Prism !== 'undefined') {
          Prism.highlightAllUnder(textMarkdown);
        }
        textMarkdown.style.display = 'block';
      }
    } else if (item.type === 'code' || CODE_EXTENSIONS_MAP[ext]) {
      if (textPre) {
        const lang = CODE_EXTENSIONS_MAP[ext] || 'clike';
        textPre.innerHTML = `<code class="language-${lang}"></code>`;
        textPre.querySelector('code').textContent = txt;
        if (typeof Prism !== 'undefined') {
          Prism.highlightAllUnder(textPre);
        }
        textPre.style.display = 'block';
      }
    } else {
      if (textPre) {
        textPre.textContent = txt;
        textPre.style.display = 'block';
      }
    }
    
    saveItemStarted(item);
  } catch (err) {
    console.error(err);
    if (textPre) {
      textPre.textContent = 'Failed to load document.';
      textPre.style.display = 'block';
    }
  }
}

// Initialize "Started" progress on text/pdf/html files
async function saveItemStarted(item) {
  if (item.progress) return; // already has progress log
  
  try {
    const res = await fetch(`${API_BASE}/api/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath: item.path,
        completed: false
      })
    });
    const progressObj = await res.json();
    syncCourseProgressMap(item.path, progressObj);
    item.progress = progressObj;
    renderActiveWorkspaceOutline();
  } catch (e) {
    console.error(e);
  }
}

// Toggle Complete via check box
async function toggleItemComplete(event, path) {
  event.stopPropagation(); // prevent selectItem firing
  
  // Find item
  let matchedItem = null;
  state.courses.forEach(c => {
    c.sections.forEach(sec => {
      sec.items.forEach(item => {
        if (item.path === path) matchedItem = item;
      });
    });
  });

  if (!matchedItem) return;

  const isNowCompleted = !(matchedItem.progress && matchedItem.progress.completed);
  const success = await saveCompletedState(matchedItem, isNowCompleted);
  updateHeaderActionBtn(); // Keep the header's Mark Complete button in sync when this is the open item

  // If completed and it is the current item, auto-advance to next item
  if (success && isNowCompleted && state.currentItem && matchedItem.path === state.currentItem.path) {
    playNextItem();
  }
}

// Toggle current loaded item complete
async function toggleCurrentItemComplete() {
  if (!state.currentItem) return;
  const isNowCompleted = !(state.currentItem.progress && state.currentItem.progress.completed);
  const success = await saveCompletedState(state.currentItem, isNowCompleted);
  updateHeaderActionBtn();
  if (success && isNowCompleted) {
    playNextItem();
  }
}

// Toggle current loaded item skip
async function toggleCurrentItemSkip() {
  if (!state.currentItem) return;
  const isNowSkipped = !(state.currentItem.progress && state.currentItem.progress.skipped);
  const success = await saveSkippedState(state.currentItem, isNowSkipped);
  updateHeaderActionBtn();
  if (success && isNowSkipped) {
    playNextItem();
  }
}

async function saveSkippedState(item, skipped) {
  try {
    const body = {
      filePath: item.path,
      skipped: skipped
    };
    
    const res = await fetch(`${API_BASE}/api/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const progressObj = await res.json();
    
    syncCourseProgressMap(item.path, progressObj);
    item.progress = progressObj;
    
    renderActiveWorkspaceOutline();
    showToast(skipped ? 'Lesson marked as skipped!' : 'Lesson marked in-progress');
    return true;
  } catch (err) {
    console.error(err);
    showToast('Failed to save skip state');
    return false;
  }
}

async function saveCompletedState(item, completed) {
  try {
    const body = {
      filePath: item.path,
      completed: completed
    };
    
    // For video files, keep current time or reset to start if marking incomplete
    if (isMediaItem(item)) {
      const video = document.getElementById('main-video-player');
      // If currently playing item is matching
      if (state.currentItem && state.currentItem.path === item.path) {
        body.currentTime = completed ? (video.duration || 0) : 0;
        body.duration = video.duration || 0;
        video.currentTime = body.currentTime;
      } else {
        body.currentTime = completed ? (item.progress ? item.progress.duration : 0) : 0;
        body.duration = item.progress ? item.progress.duration : 0;
      }
    }

    const res = await fetch(`${API_BASE}/api/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const progressObj = await res.json();
    
    syncCourseProgressMap(item.path, progressObj);
    item.progress = progressObj;
    
    renderActiveWorkspaceOutline();
    showToast(completed ? 'Lesson marked as completed!' : 'Lesson marked in-progress');
    return true;
  } catch (err) {
    console.error(err);
    showToast('Failed to save completion state');
    return false;
  }
}

// --- WORKSPACE NAV: PREV / NEXT ---
function getFlatItemsList() {
  const list = [];
  if (!state.currentCourse || !state.currentCourse.sections) return list;
  // Step through the open item's own list (lessons or resources), whichever sidebar tab is showing:
  // keying this off the tab broke Next/autoplay while browsing Resources or after resuming onto Summary
  const isLesson = state.currentItem
    ? LESSON_TYPES.includes(state.currentItem.type)
    : state.currentWorkspaceTab !== 'resources';
  const allowedTypes = isLesson ? LESSON_TYPES : ['image', 'code', 'other'];

  state.currentCourse.sections.forEach(sec => {
    sec.items.forEach(item => {
      if (allowedTypes.includes(item.type)) {
        list.push(item);
      }
    });
  });
  return list;
}

function playNextItem() {
  if (!state.currentItem) return;
  const flat = getFlatItemsList();
  const index = flat.findIndex(i => i.path === state.currentItem.path);
  if (index !== -1 && index < flat.length - 1) {
    selectItem(flat[index + 1]);
  } else {
    showToast('You reached the end of the course!');
  }
}

function playPreviousItem() {
  if (!state.currentItem) return;
  const flat = getFlatItemsList();
  const index = flat.findIndex(i => i.path === state.currentItem.path);
  if (index > 0) {
    selectItem(flat[index - 1]);
  }
}

// --- AUTOPLAY NEXT LOGIC ---
function triggerAutoplayCountdown() {
  const flat = getFlatItemsList();
  const index = flat.findIndex(i => i.path === state.currentItem.path);
  
  if (index !== -1 && index < flat.length - 1) {
    const nextItem = flat[index + 1];
    cancelAutoplay(); // Never leave an earlier countdown running where it can't be cancelled
    
    const overlay = document.getElementById('autoplay-overlay');
    const countdown = document.getElementById('autoplay-countdown');
    const nextTitle = document.getElementById('autoplay-next-title');
    
    nextTitle.textContent = nextItem.name;
    countdown.textContent = '5';
    overlay.style.display = 'flex';
    
    let timerVal = 5;
    state.autoplayTimer = setInterval(() => {
      timerVal--;
      countdown.textContent = timerVal;
      if (timerVal <= 0) {
        clearInterval(state.autoplayTimer);
        state.autoplayTimer = null;
        overlay.style.display = 'none';
        selectItem(nextItem);
      }
    }, 1000);
  }
}

function cancelAutoplay() {
  if (state.autoplayTimer) {
    clearInterval(state.autoplayTimer);
    state.autoplayTimer = null;
  }
  const overlay = document.getElementById('autoplay-overlay');
  if (overlay) overlay.style.display = 'none';
}

function triggerAutoplayNow() {
  const flat = getFlatItemsList();
  const index = flat.findIndex(i => i.path === state.currentItem.path);
  
  cancelAutoplay();
  
  if (index !== -1 && index < flat.length - 1) {
    selectItem(flat[index + 1]);
  }
}

// --- MAC NATIVE OPERATIONS ---
async function revealInFinder() {
  if (!state.currentItem) return;
  try {
    const res = await fetch(`${API_BASE}/api/open-in-finder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: state.currentItem.path })
    });
    if (res.ok) {
      showToast('Revealed file in Finder');
    }
  } catch (e) {
    console.error(e);
  }
}

async function openInSystem() {
  if (!state.currentItem) return;
  try {
    const res = await fetch(`${API_BASE}/api/open-in-system`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: state.currentItem.path })
    });
    if (res.ok) {
      showToast('Opened in Mac Default App');
    }
  } catch (e) {
    console.error(e);
  }
}

// --- SETTINGS VIEW ACTIONS ---
function renderSettings() {
  const tableBody = document.getElementById('watched-folders-table-body');
  if (tableBody) {
    tableBody.innerHTML = '';
    state.config.folders.forEach(folder => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(folder)}</td>
        <td style="text-align:right;">
          <button class="table-action-btn" title="Delete watched folder">
            <svg class="table-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </td>
      `;
      tr.querySelector('.table-action-btn').addEventListener('click', () => removeFolder(folder));
      tableBody.appendChild(tr);
    });
  }

  // Populate AI services status and model field
  if (state.aiConfig) {
    const modelInput = document.getElementById('ai-llm-model');
    const llmStatus = document.getElementById('ai-llm-status');
    const transcriptionStatus = document.getElementById('ai-transcription-status');

    if (modelInput) modelInput.value = state.aiConfig.llmModel || '';
    if (llmStatus) {
      llmStatus.textContent = state.aiConfig.llmConfigured
        ? 'API key detected'
        : 'Not configured. Add FIREWORKS_API_KEY to the .env file and restart the server.';
      llmStatus.style.color = state.aiConfig.llmConfigured ? 'var(--color-success)' : 'var(--color-warning)';
    }
    if (transcriptionStatus) {
      transcriptionStatus.textContent = state.aiConfig.transcriptionConfigured
        ? `Token detected (app: ${state.aiConfig.transcriptionApp})`
        : 'Not configured. Run "modal token set", then "npm run modal:deploy".';
      transcriptionStatus.style.color = state.aiConfig.transcriptionConfigured ? 'var(--color-success)' : 'var(--color-warning)';
    }
  }
}

async function saveAiConfig() {
  const llmModel = document.getElementById('ai-llm-model').value.trim();

  const btn = document.getElementById('btn-save-ai');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/ai-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llmModel })
    });

    if (res.ok) {
      const data = await res.json();
      state.aiConfig = data.aiConfig;

      const status = document.getElementById('ai-save-status');
      if (status) {
        status.style.display = 'inline-block';
        setTimeout(() => {
          status.style.display = 'none';
        }, 3000);
      }
      showToast('AI Configuration saved!');
    } else {
      showToast('Failed to save AI Configuration');
    }
  } catch (err) {
    console.error('Error saving AI Config:', err);
    showToast('Network error saving AI config');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function addNewFolder() {
  const input = document.getElementById('new-folder-input');
  const errorEl = document.getElementById('add-folder-error');
  const folderPath = input.value.trim();

  errorEl.textContent = '';
  if (!folderPath) {
    errorEl.textContent = 'Please enter a directory path';
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folderPath })
    });

    const data = await res.json();
    if (res.ok) {
      state.config = data;
      input.value = '';
      showToast('Folder added successfully!');
      
      // Perform deep reload & scan
      await refreshCatalog();
    } else {
      errorEl.textContent = data.error || 'Failed to add folder';
    }
  } catch (err) {
    console.error(err);
    errorEl.textContent = 'Connection error with local backend';
  }
}

async function removeFolder(folderPath) {
  try {
    const res = await fetch(`${API_BASE}/api/config/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folderPath })
    });
    const data = await res.json();
    if (res.ok) {
      state.config = data;
      showToast('Folder removed.');
      
      // Reload and scan
      await refreshCatalog();
    }
  } catch (err) {
    console.error(err);
  }
}

async function confirmResetProgress() {
  const ans = confirm("Are you absolutely sure you want to delete all watch progress, bookmark locations, and lecture read counts? This cannot be undone.");
  if (!ans) return;

  try {
    const res = await fetch(`${API_BASE}/api/progress/reset`, { method: 'POST' });
    if (res.ok) {
      showToast('All progress reset successfully');
      await refreshCatalog();
    }
  } catch (e) {
    console.error(e);
  }
}

async function confirmResetCourseProgress(event) {
  if (event) event.stopPropagation();
  if (!state.currentCourse) return;

  const ans = confirm(`Are you sure you want to reset all progress for the course "${state.currentCourse.title}"? This cannot be undone.`);
  if (!ans) return;

  try {
    const res = await fetch(`${API_BASE}/api/courses/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: state.currentCourse.id })
    });
    if (res.ok) {
      showToast(`Progress for "${state.currentCourse.title}" has been reset`);
      await refreshCatalog();
    }
  } catch (e) {
    console.error(e);
    showToast('Failed to reset course progress');
  }
}

async function confirmResetCourseProgressCard(event, courseId, courseTitle) {
  if (event) event.stopPropagation();

  const ans = confirm(`Are you sure you want to reset all progress for the course "${courseTitle}"? This cannot be undone.`);
  if (!ans) return;

  try {
    const res = await fetch(`${API_BASE}/api/courses/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: courseId })
    });
    if (res.ok) {
      showToast(`Progress for "${courseTitle}" has been reset`);
      await refreshCatalog();
    }
  } catch (e) {
    console.error(e);
    showToast('Failed to reset course progress');
  }
}

async function confirmWatchCourseProgress(event) {
  if (event) event.stopPropagation();
  if (!state.currentCourse) return;

  const ans = confirm(`Are you sure you want to mark all resources in "${state.currentCourse.title}" as completed?`);
  if (!ans) return;

  try {
    const res = await fetch(`${API_BASE}/api/courses/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: state.currentCourse.id })
    });
    if (res.ok) {
      showToast(`Course "${state.currentCourse.title}" marked as watched!`);
      await refreshCatalog();
    }
  } catch (e) {
    console.error(e);
    showToast('Failed to mark course as completed');
  }
}

async function confirmWatchCourseProgressCard(event, courseId, courseTitle) {
  if (event) event.stopPropagation();

  const ans = confirm(`Are you sure you want to mark all resources in "${courseTitle}" as completed?`);
  if (!ans) return;

  try {
    const res = await fetch(`${API_BASE}/api/courses/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: courseId })
    });
    if (res.ok) {
      showToast(`Course "${courseTitle}" marked as watched!`);
      await refreshCatalog();
    }
  } catch (e) {
    console.error(e);
    showToast('Failed to mark course as completed');
  }
}

function setSidebarState(collapsed) {
  const sidebar = document.getElementById('app-sidebar');
  if (!sidebar) return;
  
  const hasClass = sidebar.classList.contains('collapsed');
  if (hasClass === collapsed) return;
  
  if (collapsed) {
    sidebar.classList.add('collapsed');
  } else {
    sidebar.classList.remove('collapsed');
  }
  
  // Update tooltip/title for both buttons
  const titleText = collapsed ? 'Expand Sidebar' : 'Collapse Sidebar';
  const brandBtn = document.getElementById('brand-toggle-btn');
  const navBtn = document.getElementById('sidebar-toggle-btn');
  if (brandBtn) brandBtn.setAttribute('title', titleText);
  if (navBtn) navBtn.setAttribute('title', titleText);
}

function toggleSidebar() {
  const sidebar = document.getElementById('app-sidebar');
  if (!sidebar) return;
  
  const isCollapsed = !sidebar.classList.contains('collapsed');
  setSidebarState(isCollapsed);
  
  // Store state in localStorage
  localStorage.setItem('sidebar-collapsed', isCollapsed ? 'true' : 'false');
  
  // Reset auto-collapsed flag when user manually toggles
  state.sidebarAutoCollapsed = false;
}

// --- VIDEO PLAYER EXTRA SIDEBAR LOGIC (TRANSCRIPT & AI SUMMARY) ---

function toggleExtraSidebar() {
  const sidebar = document.getElementById('video-extra-sidebar');
  if (!sidebar) return;
  
  sidebar.classList.toggle('collapsed');
  const collapsed = sidebar.classList.contains('collapsed');
  localStorage.setItem('video-extra-sidebar-collapsed', collapsed ? 'true' : 'false');
}

function switchVideoExtraTab(tabName) {
  const btnTranscript = document.getElementById('btn-tab-transcript');
  const btnSummary = document.getElementById('btn-tab-summary');
  const btnChat = document.getElementById('btn-tab-chat');
  const paneTranscript = document.getElementById('pane-transcript');
  const paneSummary = document.getElementById('pane-summary');
  const paneChat = document.getElementById('pane-chat');
  
  if (!btnTranscript || !btnSummary || !btnChat || !paneTranscript || !paneSummary || !paneChat) return;
  
  btnTranscript.classList.remove('active');
  btnSummary.classList.remove('active');
  btnChat.classList.remove('active');
  
  paneTranscript.classList.remove('active');
  paneSummary.classList.remove('active');
  paneChat.classList.remove('active');
  
  if (tabName === 'transcript') {
    btnTranscript.classList.add('active');
    paneTranscript.classList.add('active');
  } else if (tabName === 'summary') {
    btnSummary.classList.add('active');
    paneSummary.classList.add('active');
  } else if (tabName === 'chat') {
    btnChat.classList.add('active');
    paneChat.classList.add('active');
    // Scroll chat to bottom when switching to it
    const messagesBody = document.getElementById('chat-messages-body');
    if (messagesBody) messagesBody.scrollTop = messagesBody.scrollHeight;
  }
}

function getEligibleItemsList() {
  const list = [];
  if (!state.currentCourse || !state.currentCourse.sections) return list;
  state.currentCourse.sections.forEach(sec => {
    sec.items.forEach(item => {
      if (AI_NOTES_TYPES.includes(item.type)) {
        list.push(item);
      }
    });
  });
  return list;
}

async function loadVideoMetadata(item) {
  const transcriptBody = document.getElementById('transcript-body');
  const summaryBody = document.getElementById('summary-body');
  if (!transcriptBody || !summaryBody) return;
  
  const isVideo = isMediaItem(item);
  transcriptBody.innerHTML = `<p class="empty-pane-msg">Checking for ${isVideo ? 'transcript' : 'extracted text'}...</p>`;
  summaryBody.innerHTML = '<p class="empty-pane-msg">Checking for summary...</p>';

  // Sync button and loading spinner state for active generation tasks
  const genBtn = document.getElementById('btn-generate-transcript');
  const spinner = document.getElementById('ai-loading-spinner');
  const statusSpan = document.getElementById('ai-loading-status');
  const isGenerating = state.generatingTranscripts && state.generatingTranscripts[item.path];
  if (genBtn && spinner) {
    if (isGenerating) {
      genBtn.style.display = 'none';
      spinner.style.display = 'flex';
      if (statusSpan) {
        statusSpan.textContent = isVideo
          ? 'Transcribing audio (takes a moment)...'
          : 'Extracting text and generating summary...';
      }
    } else {
      genBtn.style.display = '';
      spinner.style.display = 'none';
    }
  }
  
  // Reset chat state for the new item
  state.chatHistory = [];
  const chatInput = document.getElementById('chat-user-input');
  if (chatInput) {
    chatInput.placeholder = isVideo ? 'Ask a question about this lecture...' : 'Ask a question about this document...';
  }
  renderChatMessages();
  
  const hasAi = state.aiConfig && state.aiConfig.llmConfigured && (!isMediaItem(item) || state.aiConfig.transcriptionConfigured);

  try {
    const res = await fetch(`${API_BASE}/api/video/metadata?path=${encodeURIComponent(item.path)}`);
    if (!res.ok) throw new Error('Failed to load video metadata');
    
    const data = await res.json();
    // The user may have moved on while this loaded: don't show this item's notes (or auto-generate
    // notes, which targets the current item) under a different lesson
    if (!state.currentItem || state.currentItem.path !== item.path) return;
    if (data.hasTranscript && data.transcript.trim()) {
      transcriptBody.textContent = data.transcript;
    } else {
      transcriptBody.innerHTML = isVideo
        ? '<p class="empty-pane-msg">No transcript available. Click the button above to generate a transcript and summary using Modal & Fireworks AI.</p>'
        : '<p class="empty-pane-msg">No text content extracted. Click the button above to extract text and generate a summary.</p>';
    }
    
    if (data.hasSummary && data.summary.trim()) {
      summaryBody.innerHTML = parseMarkdown(data.summary);
      processAlerts(summaryBody);
      if (typeof Prism !== 'undefined') {
        Prism.highlightAllUnder(summaryBody);
      }
    } else {
      summaryBody.innerHTML = '<p class="empty-pane-msg">No summary available. Generate AI Notes to create one.</p>';
      
      // Auto-trigger generation for current item if AI services are configured
      if (!isGenerating && hasAi) {
        if (!state.autoTriggeredGenerations) {
          state.autoTriggeredGenerations = new Set();
        }
        if (!state.autoTriggeredGenerations.has(item.path)) {
          state.autoTriggeredGenerations.add(item.path);
          console.log(`[Auto] Automatically generating summary for: ${item.path}`);
          generateTranscriptAndSummaryAction();
        }
      }
    }

    // Trigger pre-generation for next 5 and previous 5 neighbors in the background
    if (hasAi) {
      const flat = getEligibleItemsList();
      const index = flat.findIndex(i => i.path === item.path);
      if (index !== -1) {
        const nextFive = flat.slice(index + 1, index + 6);
        const prevFive = flat.slice(Math.max(0, index - 5), index);
        const neighborPaths = [...nextFive, ...prevFive].map(i => i.path);

        if (neighborPaths.length > 0) {
          console.log(`[Auto] Requesting background pre-generation for ${neighborPaths.length} neighbors...`);
          fetch(`${API_BASE}/api/video/pregenerate-summaries`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: neighborPaths })
          }).catch(err => console.error('[Auto] Error requesting neighbor pre-generation:', err));
        }
      }
    }
  } catch (err) {
    console.error('Error loading video metadata:', err);
    if (!state.currentItem || state.currentItem.path !== item.path) return;
    transcriptBody.innerHTML = `<p class="empty-pane-msg">Error loading ${isVideo ? 'transcript' : 'extracted text'}.</p>`;
    summaryBody.innerHTML = '<p class="empty-pane-msg">Error loading summary.</p>';
  }
}

async function generateTranscriptAndSummaryAction() {
  if (!state.currentItem || !AI_NOTES_TYPES.includes(state.currentItem.type)) {
    showToast('No active video or document loaded.');
    return;
  }
  
  const genBtn = document.getElementById('btn-generate-transcript');
  const spinner = document.getElementById('ai-loading-spinner');
  const statusSpan = document.getElementById('ai-loading-status');
  
  if (!genBtn || !spinner) return;
  
  const isVideo = isMediaItem(state.currentItem);
  
  // Check settings configuration first
  if (!state.aiConfig || !state.aiConfig.llmConfigured || (isVideo && !state.aiConfig.transcriptionConfigured)) {
    const missingSetting = !state.aiConfig || !state.aiConfig.llmConfigured
      ? 'Fireworks AI'
      : 'Modal transcription';
    showToast(`Please set up ${missingSetting} first (see Settings)!`);
    switchView('settings');
    return;
  }
  
  const targetPath = state.currentItem.path;
  const targetItem = state.currentItem;

  if (!state.generatingTranscripts) {
    state.generatingTranscripts = {};
  }
  state.generatingTranscripts[targetPath] = true;

  genBtn.style.display = 'none';
  spinner.style.display = 'flex';
  if (statusSpan) {
    statusSpan.textContent = isVideo
      ? 'Transcribing audio (takes a moment)...'
      : 'Extracting text and generating summary...';
  }
  
  try {
    const res = await fetch(`${API_BASE}/api/video/generate-transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: targetPath })
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to generate transcription/summary');
    }
    
    const data = await res.json();
    showToast(`AI Notes generated successfully for ${targetItem.name}!`);
    
    // Refresh the metadata panel ONLY if the item is still selected
    if (state.currentItem && state.currentItem.path === targetPath) {
      await loadVideoMetadata(state.currentItem);
    }
  } catch (err) {
    console.error('Generation failed:', err);
    showToast(err.message || 'Error generating transcription/summary');
  } finally {
    if (state.generatingTranscripts) {
      delete state.generatingTranscripts[targetPath];
    }
    // Reset buttons ONLY if the item is still selected
    if (state.currentItem && state.currentItem.path === targetPath) {
      if (genBtn) genBtn.style.display = '';
      if (spinner) spinner.style.display = 'none';
    }
  }
}

const CODE_EXTENSIONS_MAP = {
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  json: 'json',
  css: 'css',
  go: 'go',
  rs: 'rust',
  rust: 'rust',
  java: 'java',
  cpp: 'cpp',
  c: 'c',
  h: 'c',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  sql: 'sql',
  ini: 'ini',
  conf: 'ini',
  html: 'markup',
  htm: 'markup',
  md: 'markdown'
};

function processAlerts(containerEl) {
  if (!containerEl) return;
  const blockquotes = containerEl.querySelectorAll('blockquote');
  blockquotes.forEach(bq => {
    const paragraphs = bq.querySelectorAll('p');
    if (paragraphs.length === 0) return;
    
    const firstP = paragraphs[0];
    const htmlText = firstP.innerHTML.trim();
    
    const match = htmlText.match(/^\[!(NOTE|IMPORTANT|WARNING|TIP|CAUTION)\](?:\s|<br>|\n)?([\s\S]*)$/i);
    if (match) {
      const type = match[1].toUpperCase();
      const content = match[2];
      
      bq.className = `callout-block callout-${type.toLowerCase()}`;
      firstP.innerHTML = content.trim();
      
      const header = document.createElement('div');
      header.className = 'callout-header';
      header.innerHTML = `${getCalloutIcon(type)}<span class="callout-title">${getCalloutLabel(type)}</span>`;
      bq.insertBefore(header, bq.firstChild);
    }
  });
}

function getCalloutIcon(type) {
  switch (type) {
    case 'NOTE':
      return `<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
    case 'TIP':
      return `<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M15.09 14c.18-.19.33-.42.49-.67a6 6 0 1 0-7.18 0c.16.25.31.48.49.67a5 5 0 0 1 1.09 3.19h4a5 5 0 0 1 1.12-3.19z"/></svg>`;
    case 'IMPORTANT':
      return `<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    case 'WARNING':
      return `<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
    case 'CAUTION':
      return `<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    default:
      return '';
  }
}

function getCalloutLabel(type) {
  switch (type) {
    case 'NOTE':
      return 'Note';
    case 'TIP':
      return 'Tip';
    case 'IMPORTANT':
      return 'Important';
    case 'WARNING':
      return 'Warning';
    case 'CAUTION':
      return 'Caution';
    default:
      return type;
  }
}

// DOMPurify's default link allowlist, plus the timestamp: links that AI notes use to seek within lessons
const MARKDOWN_ALLOWED_URI = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|timestamp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

function parseMarkdown(md) {
  if (!md) return '';

  const placeholders = [];
  let placeholderCount = 0;

  // Extract block math $$...$$
  let processedMd = md.replace(/\$\$([\s\S]+?)\$\$/g, (match, math) => {
    const placeholder = `@@MATH_BLOCK_${placeholderCount++}@@`;
    placeholders.push({ placeholder, math, displayMode: true, raw: match });
    return placeholder;
  });

  // Extract inline math $...$ (a closing $ followed by a digit is currency, as in "$3,500–$4,000")
  processedMd = processedMd.replace(/\$((?!\s)(?:[^\$\\]|\\.)+?)(?<!\s)\$(?!\d)/g, (match, math) => {
    const placeholder = `@@MATH_BLOCK_${placeholderCount++}@@`;
    placeholders.push({ placeholder, math, displayMode: false, raw: match });
    return placeholder;
  });

  // Parse Markdown (marked.js or custom fallback)
  let html = '';
  if (typeof marked !== 'undefined' && marked.parse) {
    try {
      html = marked.parse(processedMd, { gfm: true, breaks: true });
    } catch (err) {
      console.error('Marked rendering error:', err);
      html = fallbackParseMarkdown(processedMd);
    }
  } else {
    html = fallbackParseMarkdown(processedMd);
  }

  // Restore the math placeholders with rendered KaTeX HTML
  placeholders.forEach(({ placeholder, math, displayMode, raw }) => {
    let renderedMath = raw;
    if (typeof katex !== 'undefined') {
      try {
        renderedMath = katex.renderToString(math, {
          displayMode: displayMode,
          throwOnError: false,
          // HTML only: the sanitizer below strips MathML's <semantics> and <annotation> tags
          output: 'html'
        });
      } catch (err) {
        console.error('KaTeX rendering error:', err);
      }
    } else {
      renderedMath = displayMode 
        ? `<pre class="raw-math">${raw}</pre>` 
        : `<code class="raw-math">${raw}</code>`;
    }
    html = html.split(placeholder).join(renderedMath);
  });

  // Course files and AI replies can both carry HTML such as <img onerror=...>, which would run as the app.
  // Without the sanitizer, show the source as plain text rather than unchecked HTML.
  if (typeof DOMPurify === 'undefined') {
    return `<p>${escapeHtml(md).replace(/\n/g, '<br>')}</p>`;
  }
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: MARKDOWN_ALLOWED_URI,
    // A form would still post to the API (e.g. reset all progress) once its button is clicked
    FORBID_TAGS: ['form']
  });
}

function fallbackParseMarkdown(md) {
  let html = md;
  // Escape HTML tags to prevent XSS
  html = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  
  // Parse Markdown links: [text](url) -> <a href="url">text</a>
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  
  // Headers
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
  
  // Bold
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  
  // Italic
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  
  // Line-by-line list block parsing
  const lines = html.split('\n');
  let inList = false;
  const processedLines = [];
  
  for (let line of lines) {
    const trimmed = line.trim();
    // Match line starting with asterisks or hyphen, like "* item" or "- item"
    const listMatch = trimmed.match(/^[\*\-]\s+(.*)$/);
    
    if (listMatch) {
      if (!inList) {
        processedLines.push('<ul>');
        inList = true;
      }
      processedLines.push(`<li>${listMatch[1]}</li>`);
    } else {
      if (inList) {
        processedLines.push('</ul>');
        inList = false;
      }
      if (trimmed === '') {
        processedLines.push('<br>');
      } else if (!trimmed.startsWith('<h') && !trimmed.startsWith('<u') && !trimmed.startsWith('<l')) {
        processedLines.push(`<p>${line}</p>`);
      } else {
        processedLines.push(line);
      }
    }
  }
  
  if (inList) {
    processedLines.push('</ul>');
  }
  
  return processedLines.join('\n');
}

// --- COURSE SUMMARY FRONTEND LOGIC ---
let courseSummaryPollInterval = null;

window.toggleSummaryScopeCard = function() {
  const card = document.getElementById('summary-scope-card');
  if (card) card.classList.toggle('collapsed');
};

window.setScopePreset = function(preset) {
  const checkboxes = document.querySelectorAll('.scope-checkbox[data-path]');
  checkboxes.forEach(cb => {
    const type = cb.getAttribute('data-type');
    const isVideo = type === 'video';
    const isDoc = type === 'document';
    let check = false;
    if (preset === 'all') check = true;
    else if (preset === 'none') check = false;
    else if (preset === 'videos') check = isVideo;
    else if (preset === 'documents') check = isDoc;
    
    if (check) {
      cb.classList.add('checked');
    } else {
      cb.classList.remove('checked');
    }
  });

  updateSectionCheckboxes();
};

window.toggleScopeItemCheckbox = function(checkboxId) {
  const cb = document.getElementById(checkboxId);
  if (cb) cb.classList.toggle('checked');
  updateSectionCheckboxes();
};

window.toggleSectionCheckbox = function(secIdx) {
  const secCb = document.getElementById(`scope-section-cb-${secIdx}`);
  if (!secCb) return;

  const isChecking = !secCb.classList.contains('checked');
  if (isChecking) {
    secCb.classList.add('checked');
  } else {
    secCb.classList.remove('checked');
  }

  const fileCbs = document.querySelectorAll(`[id^="scope-item-cb-${secIdx}-"]`);
  fileCbs.forEach(cb => {
    if (isChecking) {
      cb.classList.add('checked');
    } else {
      cb.classList.remove('checked');
    }
  });
};

function updateSectionCheckboxes() {
  if (!state.currentCourse) return;
  state.currentCourse.sections.forEach((sec, secIdx) => {
    const secCb = document.getElementById(`scope-section-cb-${secIdx}`);
    if (!secCb) return;

    const fileCbs = document.querySelectorAll(`[id^="scope-item-cb-${secIdx}-"]`);
    if (fileCbs.length === 0) return;

    let allChecked = true;
    fileCbs.forEach(cb => {
      if (!cb.classList.contains('checked')) {
        allChecked = false;
      }
    });

    if (allChecked) {
      secCb.classList.add('checked');
    } else {
      secCb.classList.remove('checked');
    }
  });
}

function renderSummaryScopeSelector() {
  const card = document.getElementById('summary-scope-card');
  const listContainer = document.getElementById('summary-scope-files-list');
  if (!card || !listContainer || !state.currentCourse) return;

  listContainer.innerHTML = '';
  let count = 0;

  state.currentCourse.sections.forEach((sec, secIdx) => {
    // Matches the types the course summary job reads in server.js
    const eligibleItems = sec.items.filter(item => ['video', 'audio', 'text', 'html', 'pdf', 'docx'].includes(item.type));

    if (eligibleItems.length === 0) return;

    const groupDiv = document.createElement('div');
    groupDiv.className = 'scope-section-group';

    const titleRow = document.createElement('div');
    titleRow.className = 'scope-section-title-row';
    titleRow.onclick = () => window.toggleSectionCheckbox(secIdx);

    const secCheckbox = document.createElement('div');
    secCheckbox.className = 'scope-checkbox checked';
    secCheckbox.id = `scope-section-cb-${secIdx}`;
    secCheckbox.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="width: 10px; height: 10px; display: block; color: #0d0e1b;"><polyline points="20 6 9 17 4 12"/></svg>`;
    titleRow.appendChild(secCheckbox);

    const titleSpan = document.createElement('span');
    titleSpan.className = 'scope-section-title';
    titleSpan.textContent = sec.name;
    titleRow.appendChild(titleSpan);

    groupDiv.appendChild(titleRow);

    eligibleItems.forEach((item, itemIdx) => {
      const rowId = `scope-item-cb-${secIdx}-${itemIdx}`;
      const isVideo = isMediaItem(item);
      const fileIconSvg = isVideo 
        ? `<svg class="scope-file-icon video" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; margin-right: 4px;"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`
        : `<svg class="scope-file-icon document" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; margin-right: 4px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;

      const row = document.createElement('div');
      row.className = 'scope-item-row';
      row.onclick = () => window.toggleScopeItemCheckbox(rowId);

      const checkbox = document.createElement('div');
      checkbox.className = 'scope-checkbox checked';
      checkbox.id = rowId;
      checkbox.setAttribute('data-path', item.path);
      checkbox.setAttribute('data-type', isVideo ? 'video' : 'document');
      checkbox.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="width: 10px; height: 10px; display: block; color: #0d0e1b;"><polyline points="20 6 9 17 4 12"/></svg>`;

      const label = document.createElement('span');
      label.className = 'scope-file-name';
      label.textContent = item.name;

      row.appendChild(checkbox);
      
      const tempSpan = document.createElement('span');
      tempSpan.innerHTML = fileIconSvg;
      row.appendChild(tempSpan.firstElementChild);
      
      row.appendChild(label);
      groupDiv.appendChild(row);
      count++;
    });

    listContainer.appendChild(groupDiv);
  });

  if (count > 0) {
    card.style.display = 'block';
  } else {
    card.style.display = 'none';
  }
  
  updateSectionCheckboxes();
}

async function loadCourseSummary() {
  if (!state.currentCourse) return;
  
  const contentArea = document.getElementById('course-summary-content');
  const progressContainer = document.getElementById('course-summary-progress-container');
  const genBtn = document.getElementById('btn-generate-course-summary');
  const toggleBtn = document.getElementById('btn-toggle-course-chat');
  
  if (!contentArea || !progressContainer || !genBtn) return;
  if (toggleBtn) toggleBtn.style.display = 'flex';
  
  // Clear any existing polling loop
  if (courseSummaryPollInterval) {
    clearInterval(courseSummaryPollInterval);
    courseSummaryPollInterval = null;
  }
  
  contentArea.innerHTML = '<p class="empty-pane-msg" style="text-align: center; padding: 40px 0;">Loading course summary status...</p>';
  progressContainer.style.display = 'none';
  genBtn.style.display = '';

  try {
    const res = await fetch(`${API_BASE}/api/course/summary-status?courseId=${encodeURIComponent(state.currentCourse.id)}`);
    if (!res.ok) throw new Error('Failed to load course summary status');
    
    const data = await res.json();
    
    // Render the file checklist
    renderSummaryScopeSelector();
    const card = document.getElementById('summary-scope-card');
    
    if (data.status === 'processing') {
      showCourseSummaryProgress(data);
      startPollingCourseSummary();
      if (card) card.style.display = 'none';
    } else if (data.status === 'completed' || data.hasSummary) {
      if (data.summary) {
        contentArea.innerHTML = parseMarkdown(data.summary);
        processAlerts(contentArea);
        if (typeof Prism !== 'undefined') {
          Prism.highlightAllUnder(contentArea);
        }
      } else {
        contentArea.innerHTML = '<p class="empty-pane-msg" style="text-align: center; padding: 40px 0;">Summary file found, but content is empty.</p>';
      }
      genBtn.textContent = 'Regenerate Summary';
      if (card) card.classList.add('collapsed');
    } else if (data.status === 'failed') {
      contentArea.innerHTML = `
        <div class="empty-pane-msg" style="text-align: center; padding: 40px 0; color: var(--color-danger);">
          <p>Previous generation failed: ${escapeHtml(data.error || 'Unknown error')}</p>
          <p style="font-size: 12px; color: var(--text-muted); margin-top: 8px;">Click below to retry.</p>
        </div>
      `;
      genBtn.textContent = 'Generate Course Summary';
      if (card) card.classList.remove('collapsed');
    } else {
      contentArea.innerHTML = '<p class="empty-pane-msg" style="text-align: center; padding: 40px 0;">No course-level summary generated yet. Click "Generate Course Summary" to analyze all lessons and extract key takeaways.</p>';
      genBtn.textContent = 'Generate Course Summary';
      if (card) card.classList.remove('collapsed');
    }
  } catch (err) {
    console.error('Error fetching course summary status:', err);
    contentArea.innerHTML = '<p class="empty-pane-msg" style="text-align: center; padding: 40px 0; color: var(--color-danger);">Error checking course summary status.</p>';
  }
}

function showCourseSummaryProgress(data) {
  const progressContainer = document.getElementById('course-summary-progress-container');
  const statusText = document.getElementById('course-summary-status-text');
  const progressBar = document.getElementById('course-summary-progress-bar');
  const logArea = document.getElementById('course-summary-log');
  const genBtn = document.getElementById('btn-generate-course-summary');
  const contentArea = document.getElementById('course-summary-content');

  if (!progressContainer || !statusText || !progressBar || !logArea || !genBtn || !contentArea) return;

  progressContainer.style.display = 'flex';
  genBtn.style.display = 'none';
  contentArea.innerHTML = '<p class="empty-pane-msg" style="text-align: center; padding: 40px 0;">Analyzing course contents... Keep this tab open to monitor progress.</p>';

  statusText.textContent = data.progress || 'Processing...';
  progressBar.style.width = `${data.percent || 0}%`;
  
  if (data.logs) {
    logArea.textContent = data.logs;
    logArea.scrollTop = logArea.scrollHeight;
  }
}

async function generateCourseSummaryAction() {
  if (!state.currentCourse) return;

  if (!state.aiConfig || !state.aiConfig.llmConfigured) {
    showToast('Please set up Fireworks AI first (see Settings)!');
    switchView('settings');
    return;
  }

  // Get checked file paths
  const checkedBoxes = document.querySelectorAll('#summary-scope-files-list .scope-checkbox.checked[data-path]');
  const selectedFiles = Array.from(checkedBoxes).map(cb => cb.getAttribute('data-path'));

  if (selectedFiles.length === 0) {
    showToast('Please select at least one file to summarize.');
    return;
  }

  const genBtn = document.getElementById('btn-generate-course-summary');
  if (genBtn) genBtn.style.display = 'none';

  const card = document.getElementById('summary-scope-card');
  if (card) card.style.display = 'none';

  try {
    const res = await fetch(`${API_BASE}/api/course/generate-summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        courseId: state.currentCourse.id,
        selectedFiles: selectedFiles
      })
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to start summary generation');
    }

    const data = await res.json();
    showCourseSummaryProgress(data);
    startPollingCourseSummary();
    showToast('Course summary generation started.');
  } catch (err) {
    console.error('Failed to start course summary:', err);
    showToast(err.message || 'Error starting course summary generation');
    if (genBtn) genBtn.style.display = '';
    if (card) card.style.display = 'block';
  }
}

function startPollingCourseSummary() {
  if (courseSummaryPollInterval) clearInterval(courseSummaryPollInterval);

  courseSummaryPollInterval = setInterval(async () => {
    if (!state.currentCourse || state.currentWorkspaceTab !== 'course-summary') {
      clearInterval(courseSummaryPollInterval);
      courseSummaryPollInterval = null;
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/course/summary-status?courseId=${encodeURIComponent(state.currentCourse.id)}`);
      if (!res.ok) throw new Error('Polling status failed');

      const data = await res.json();
      showCourseSummaryProgress(data);

      if (data.status === 'completed') {
        clearInterval(courseSummaryPollInterval);
        courseSummaryPollInterval = null;
        showToast('Course summary generated successfully!');
        await loadCourseSummary();
      } else if (data.status === 'failed') {
        clearInterval(courseSummaryPollInterval);
        courseSummaryPollInterval = null;
        showToast('Course summary generation failed!');
        await loadCourseSummary();
      }
    } catch (err) {
      console.error('Error polling course summary status:', err);
    }
  }, 1500);
}

// --- CHAT WITH TRANSCRIPT FRONTEND LOGIC ---
function renderChatMessages() {
  const messagesBody = document.getElementById('chat-messages-body');
  const suggestionsList = document.getElementById('chat-suggestions-list');
  if (!messagesBody) return;

  if (state.chatHistory.length === 0) {
    const isVideo = isMediaItem(state.currentItem);
    messagesBody.innerHTML = isVideo
      ? '<p class="empty-pane-msg">Ask questions about this lecture\'s transcript. Start by typing a question below or selecting a suggestion.</p>'
      : '<p class="empty-pane-msg">Ask questions about this document\'s content. Start by typing a question below or selecting a suggestion.</p>';
    if (suggestionsList) suggestionsList.style.display = 'flex';
    return;
  }

  if (suggestionsList) suggestionsList.style.display = 'none';
  
  messagesBody.innerHTML = state.chatHistory.map(msg => {
    const isUser = msg.role === 'user';
    const parsedContent = isUser ? escapeHtml(msg.content) : parseMarkdown(msg.content);
    return `
      <div class="chat-message ${isUser ? 'user' : 'assistant'}">
        ${parsedContent}
      </div>
    `;
  }).join('');

  messagesBody.scrollTop = messagesBody.scrollHeight;
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function sendChatMessage() {
  const inputEl = document.getElementById('chat-user-input');
  if (!inputEl) return;
  const messageText = inputEl.value.trim();
  if (!messageText) return;

  // Clear the box right away, so the question can't be sent twice while the answer is pending
  inputEl.value = '';
  inputEl.style.height = 'auto';
  await executeChatMessage(messageText);
}

async function sendQuickQuestion(text) {
  await executeChatMessage(text);
}

function handleChatInputKeyDown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendChatMessage();
  }
}

async function executeChatMessage(messageText) {
  if (!state.currentItem || !AI_NOTES_TYPES.includes(state.currentItem.type)) {
    showToast('No active video or document loaded.');
    return;
  }

  // Push user message. Keep a handle on this conversation: opening another item starts a new one,
  // and a late answer must not be appended to it
  const history = state.chatHistory;
  history.push({ role: 'user', content: messageText });
  renderChatMessages();

  // Show typing indicator
  const messagesBody = document.getElementById('chat-messages-body');
  const indicator = document.createElement('div');
  indicator.className = 'typing-indicator';
  indicator.id = 'chat-typing-indicator';
  indicator.innerHTML = `
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
  `;
  messagesBody.appendChild(indicator);
  messagesBody.scrollTop = messagesBody.scrollHeight;

  try {
    const res = await fetch(`${API_BASE}/api/video/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: state.currentItem.path,
        message: messageText,
        history: history.slice(0, -1)
      })
    });

    indicator.remove();

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to get AI response');
    }

    const data = await res.json();
    if (state.chatHistory !== history) return;
    history.push({ role: 'model', content: data.response });
    renderChatMessages();
  } catch (err) {
    console.error('Chat failed:', err);
    indicator.remove();
    if (state.chatHistory !== history) return;

    history.push({ role: 'model', content: `Error: ${err.message || 'Could not communicate with AI assistant.'}` });
    renderChatMessages();
    
    const lastMsgEl = messagesBody.lastElementChild;
    if (lastMsgEl) lastMsgEl.classList.add('error');
  }
}

// Bind to window for HTML accessibility
window.sendQuickQuestion = sendQuickQuestion;
window.handleChatInputKeyDown = handleChatInputKeyDown;
window.sendChatMessage = sendChatMessage;
window.renderChatMessages = renderChatMessages;

// --- COURSE-WIDE CHAT FRONTEND LOGIC ---
function toggleCourseChat() {
  const panel = document.getElementById('course-chat-panel');
  if (!panel) return;
  
  if (panel.style.display === 'none' || !panel.style.display) {
    panel.style.display = 'flex';
    // Scroll messages to bottom when opening
    const messagesBody = document.getElementById('course-chat-messages-body');
    if (messagesBody) messagesBody.scrollTop = messagesBody.scrollHeight;
  } else {
    panel.style.display = 'none';
  }
}

function renderCourseChatMessages() {
  const messagesBody = document.getElementById('course-chat-messages-body');
  const suggestionsList = document.getElementById('course-chat-suggestions-list');
  if (!messagesBody) return;

  if (state.courseChatHistory.length === 0) {
    messagesBody.innerHTML = '<p class="empty-pane-msg">Ask any question about the entire course content, summaries, or cross-topic relationships.</p>';
    if (suggestionsList) suggestionsList.style.display = 'flex';
    return;
  }

  if (suggestionsList) suggestionsList.style.display = 'none';
  
  messagesBody.innerHTML = state.courseChatHistory.map(msg => {
    const isUser = msg.role === 'user';
    const parsedContent = isUser ? escapeHtml(msg.content) : parseMarkdown(msg.content);
    return `
      <div class="chat-message ${isUser ? 'user' : 'assistant'}">
        ${parsedContent}
      </div>
    `;
  }).join('');

  messagesBody.scrollTop = messagesBody.scrollHeight;
}

async function sendCourseChatMessage() {
  const inputEl = document.getElementById('course-chat-user-input');
  if (!inputEl) return;
  const messageText = inputEl.value.trim();
  if (!messageText) return;

  // Clear the box right away, so the question can't be sent twice while the answer is pending
  inputEl.value = '';
  inputEl.style.height = 'auto';
  await executeCourseChatMessage(messageText);
}

async function sendCourseQuickQuestion(text) {
  await executeCourseChatMessage(text);
}

function handleCourseChatInputKeyDown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendCourseChatMessage();
  }
}

async function executeCourseChatMessage(messageText) {
  if (!state.currentCourse) {
    showToast('No active course loaded.');
    return;
  }

  // Push user message (opening another course starts a new conversation; see executeChatMessage)
  const history = state.courseChatHistory;
  history.push({ role: 'user', content: messageText });
  renderCourseChatMessages();

  // Show typing indicator
  const messagesBody = document.getElementById('course-chat-messages-body');
  const indicator = document.createElement('div');
  indicator.className = 'typing-indicator';
  indicator.id = 'course-chat-typing-indicator';
  indicator.innerHTML = `
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
  `;
  messagesBody.appendChild(indicator);
  messagesBody.scrollTop = messagesBody.scrollHeight;

  try {
    const res = await fetch(`${API_BASE}/api/course/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courseId: state.currentCourse.id,
        message: messageText,
        history: history.slice(0, -1)
      })
    });

    indicator.remove();

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to get AI response');
    }

    const data = await res.json();
    if (state.courseChatHistory !== history) return;
    history.push({ role: 'model', content: data.response });
    renderCourseChatMessages();
  } catch (err) {
    console.error('Course chat failed:', err);
    indicator.remove();
    if (state.courseChatHistory !== history) return;

    history.push({ role: 'model', content: `Error: ${err.message || 'Could not communicate with AI assistant.'}` });
    renderCourseChatMessages();
    
    const lastMsgEl = messagesBody.lastElementChild;
    if (lastMsgEl) lastMsgEl.classList.add('error');
  }
}

// Bind to window for HTML accessibility
window.toggleCourseChat = toggleCourseChat;
window.sendCourseQuickQuestion = sendCourseQuickQuestion;
window.handleCourseChatInputKeyDown = handleCourseChatInputKeyDown;
window.sendCourseChatMessage = sendCourseChatMessage;
window.renderCourseChatMessages = renderCourseChatMessages;

