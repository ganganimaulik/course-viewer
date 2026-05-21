// --- API CONFIGURATION ---
const API_BASE = window.location.protocol === 'file:' ? 'http://localhost:3005' : '';

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
  currentWorkspaceTab: 'lessons'
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
});

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
        document.getElementById('workspace-course-progress').textContent = `${updatedCourse.progressPercent}% Completed`;
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
          if (item.type === 'video' && item.progress.currentTime) {
            totalWatchedSeconds += item.progress.currentTime;
          }
          if (item.progress.completed) {
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
      const progressLabel = item.type === 'video' 
        ? `${formatTime(item.progress.currentTime)} / ${formatTime(item.progress.duration)} (${percent}%)`
        : (item.progress.completed ? 'Completed' : 'Started');

      const dateStudied = getRelativeTime(new Date(item.progress.lastStudied));

      card.innerHTML = `
        <div class="resume-card-header">
          <span class="resume-type-badge ${item.type}">${item.type}</span>
          <span class="resume-date">${dateStudied}</span>
        </div>
        <div class="resume-title-box">
          <div class="resume-course-title">${item.courseTitle}</div>
          <div class="resume-file-title" title="${item.name}">${item.name}</div>
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
    let videos = 0, pdfs = 0, htmls = 0, texts = 0, others = 0;
    c.sections.forEach(sec => {
      sec.items.forEach(i => {
        if (i.type === 'video') videos++;
        else if (i.type === 'pdf') pdfs++;
        else if (i.type === 'html') htmls++;
        else if (i.type === 'text') texts++;
        else others++;
      });
    });

    const folderBadge = displayPath(c.sourceRoot).split('/').pop();

    card.innerHTML = `
      <div class="course-card-top">
        <div class="badge-and-reset">
          <span class="course-source-badge" title="${c.sourceRoot}">${folderBadge}</span>
          ${(c.completedItems > 0 || c.hasProgress) ? `
            <button class="card-reset-btn" onclick="confirmResetCourseProgressCard(event, '${c.id}', '${c.title.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"')}')" title="Reset Course Progress">
              <svg class="card-reset-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            </button>
          ` : ''}
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
      <div class="course-title" title="${c.title}">${c.title}</div>
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
      </div>
    `;
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
  
  openCourse(item.courseId);
  selectItem(item);
}

// Open Course outline view
function openCourse(courseId, restoreItemPath = null) {
  const course = state.courses.find(c => c.id === courseId);
  if (!course) return;

  state.currentCourse = course;
  localStorage.setItem('current-course-id', courseId);
  if (!restoreItemPath) {
    localStorage.removeItem('current-item-path');
  }
  switchView('workspace');

  document.getElementById('workspace-course-title').textContent = course.title;
  document.getElementById('workspace-course-progress').textContent = `${course.progressPercent}% Completed`;
  
  // Restore tab
  const storedTab = localStorage.getItem('current-workspace-tab') || 'lessons';
  state.currentWorkspaceTab = storedTab;
  const tabLessons = document.getElementById('tab-lessons');
  const tabResources = document.getElementById('tab-resources');
  if (tabLessons) {
    if (storedTab === 'lessons') tabLessons.classList.add('active');
    else tabLessons.classList.remove('active');
  }
  if (tabResources) {
    if (storedTab === 'resources') tabResources.classList.add('active');
    else tabResources.classList.remove('active');
  }
  
  const listLessons = document.getElementById('course-outline-list');
  const listResources = document.getElementById('course-resources-list');
  if (listLessons) listLessons.style.display = storedTab === 'lessons' ? 'block' : 'none';
  if (listResources) listResources.style.display = storedTab === 'resources' ? 'block' : 'none';

  const searchInput = document.getElementById('outline-search');
  if (searchInput) {
    searchInput.value = '';
    searchInput.placeholder = storedTab === 'lessons' ? 'Search lectures...' : 'Search resources...';
  }

  renderActiveWorkspaceOutline();

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
  
  // Set breadcrumbs initial
  document.getElementById('crumb-course').textContent = 'Dashboard';
  document.getElementById('crumb-section').textContent = course.title;
  if (!restoreItemPath) {
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
      const isCore = ['video', 'pdf', 'html', 'text'].includes(item.type);
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
        <span class="section-title-text" title="${section.name}">${section.name}</span>
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
      itemRow.id = `item-row-${item.name.replace(/\s+/g, '_')}`;
      
      // Determine file icon
      let typeIcon = '';
      if (item.type === 'video') {
        typeIcon = '<svg class="outline-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
      } else if (item.type === 'pdf') {
        typeIcon = '<svg class="outline-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      } else if (item.type === 'html') {
        typeIcon = '<svg class="outline-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
      } else if (item.type === 'text') {
        typeIcon = '<svg class="outline-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>';
      } else {
        typeIcon = '<svg class="outline-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      }

      // Checkbox checked state
      const isCompleted = item.progress && item.progress.completed;
      const checkedClass = isCompleted ? 'checked' : '';

      itemRow.innerHTML = `
        <div class="item-check-checkbox ${checkedClass}" onclick="toggleItemComplete(event, '${item.path}')">
          <svg class="check-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        ${typeIcon}
        <span class="outline-item-name" title="${item.name}">${item.name}</span>
      `;

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
        <span class="section-title-text" title="${section.name}">${section.name}</span>
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
      itemRow.id = `item-row-${item.name.replace(/\s+/g, '_')}`;
      
      // Determine file icon
      let typeIcon = '';
      if (item.type === 'image') {
        typeIcon = '<svg class="outline-item-icon image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
      } else if (item.type === 'code') {
        typeIcon = '<svg class="outline-item-icon code" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
      } else {
        typeIcon = '<svg class="outline-item-icon other" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      }

      // Checkbox checked state
      const isCompleted = item.progress && item.progress.completed;
      const checkedClass = isCompleted ? 'checked' : '';

      itemRow.innerHTML = `
        <div class="item-check-checkbox ${checkedClass}" onclick="toggleItemComplete(event, '${item.path}')">
          <svg class="check-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        ${typeIcon}
        <span class="outline-item-name" title="${item.name}">${item.name}</span>
      `;

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
  if (tabName !== 'lessons' && tabName !== 'resources') return;
  state.currentWorkspaceTab = tabName;
  localStorage.setItem('current-workspace-tab', tabName);

  const tabLessons = document.getElementById('tab-lessons');
  const tabResources = document.getElementById('tab-resources');
  const listLessons = document.getElementById('course-outline-list');
  const listResources = document.getElementById('course-resources-list');
  const searchInput = document.getElementById('outline-search');

  if (searchInput) searchInput.value = '';

  if (tabName === 'lessons') {
    if (tabLessons) tabLessons.classList.add('active');
    if (tabResources) tabResources.classList.remove('active');
    if (listLessons) listLessons.style.display = 'block';
    if (listResources) listResources.style.display = 'none';
    if (searchInput) searchInput.placeholder = 'Search lectures...';
  } else {
    if (tabLessons) tabLessons.classList.remove('active');
    if (tabResources) tabResources.classList.add('active');
    if (listLessons) listLessons.style.display = 'none';
    if (listResources) listResources.style.display = 'block';
    if (searchInput) searchInput.placeholder = 'Search resources...';
  }

  renderActiveWorkspaceOutline();
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
  if (!actionBtn || !state.currentItem) return;
  const isCompleted = state.currentItem.progress && state.currentItem.progress.completed;
  if (isCompleted) {
    actionBtn.classList.add('completed');
    actionBtn.querySelector('span').textContent = 'Completed';
  } else {
    actionBtn.classList.remove('completed');
    actionBtn.querySelector('span').textContent = 'Mark Complete';
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

  // Active state class toggle in outline
  document.querySelectorAll('.outline-item').forEach(el => {
    el.classList.remove('active');
  });
  const activeRow = document.getElementById(`item-row-${item.name.replace(/\s+/g, '_')}`);
  if (activeRow) activeRow.classList.add('active');

  // Load breadcrumbs
  document.getElementById('crumb-section').textContent = state.currentSection.name;
  document.getElementById('crumb-item').textContent = item.name;
  document.getElementById('crumb-item').classList.add('active');

  // Enable/Show top actions bar
  updateHeaderActionBtn();
  document.getElementById('file-actions-bar').style.display = 'flex';

  // Toggle based on file type
  showViewerPanel(item.type);

  if (item.type === 'video') {
    loadVideoPlayer(item);
  } else if (item.type === 'pdf') {
    const iframe = document.getElementById('pdf-frame');
    iframe.src = `${API_BASE}/api/file?path=${encodeURIComponent(item.path)}`;
    saveItemStarted(item);
  } else if (item.type === 'html') {
    const iframe = document.getElementById('html-frame');
    iframe.src = `${API_BASE}/api/file?path=${encodeURIComponent(item.path)}`;
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
}

// Toggle visible containers inside viewport
function showViewerPanel(type) {
  const panels = {
    blank: 'viewer-blank',
    video: 'viewer-video-container',
    pdf: 'viewer-pdf-container',
    html: 'viewer-html-container',
    text: 'viewer-text-container',
    image: 'viewer-image-container',
    code: 'viewer-text-container',
    other: 'viewer-other-container'
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
    startProgressInterval();
  });

  video.addEventListener('pause', () => {
    playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    stopProgressInterval();
    saveVideoProgress(true); // Save progress instantly on pause
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
    document.getElementById('video-total-duration').textContent = formatTime(video.duration);
    
    // Set speed rate
    video.playbackRate = state.playbackRate;
    document.getElementById('video-speed-btn').textContent = `${state.playbackRate.toFixed(2)}x`;

    // Seek to last currentTime position
    if (state.currentItem && state.currentItem.progress && state.currentItem.progress.currentTime) {
      video.currentTime = state.currentItem.progress.currentTime;
    }
  });

  video.addEventListener('ended', () => {
    stopProgressInterval();
    saveVideoProgress(true, true); // Save as completed
    triggerAutoplayCountdown();
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
  
  // Clear tracks and sources
  video.innerHTML = '';
  
  // Set video source
  const source = document.createElement('source');
  source.src = `${API_BASE}/api/video?path=${encodeURIComponent(item.path)}`;
  video.appendChild(source);

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
    // Ignore when typing in input/textarea/contenteditable fields
    if (document.activeElement && (
      document.activeElement.tagName === 'INPUT' ||
      document.activeElement.tagName === 'TEXTAREA' ||
      document.activeElement.isContentEditable
    )) {
      return;
    }

    // Only run shortcut actions if viewing the workspace and currently loaded item is a video
    if (state.view !== 'workspace' || !state.currentItem || state.currentItem.type !== 'video') {
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
  if (!video.duration || !state.currentItem) return;

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
          filePath: state.currentItem.path,
          currentTime: now,
          duration: video.duration,
          completed: isCompleted ? true : undefined
        })
      });
      const data = await res.json();
      
      // Update item progress model locally
      state.currentItem.progress = data;
      
      // Sync local courses progress values
      syncCourseProgressMap(state.currentItem.path, data);

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
          const wasCompleted = item.progress && item.progress.completed;
          item.progress = progressObj;
          
          if (wasCompleted !== progressObj.completed) {
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
          if (item.progress.completed) completedItems++;
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
  }
}

// --- TEXT / DOCUMENT VIEWER LOGIC ---
async function loadTextViewer(item) {
  const textPre = document.getElementById('text-pre-content');
  textPre.textContent = 'Loading text document...';

  try {
    const res = await fetch(`${API_BASE}/api/file?path=${encodeURIComponent(item.path)}`);
    const txt = await res.text();
    textPre.textContent = txt;
    saveItemStarted(item);
  } catch (err) {
    console.error(err);
    textPre.textContent = 'Failed to load text file.';
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
    item.progress = progressObj;
    syncCourseProgressMap(item.path, progressObj);
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
  await saveCompletedState(matchedItem, isNowCompleted);
}

// Toggle current loaded item complete
async function toggleCurrentItemComplete() {
  if (!state.currentItem) return;
  const isNowCompleted = !(state.currentItem.progress && state.currentItem.progress.completed);
  await saveCompletedState(state.currentItem, isNowCompleted);
  updateHeaderActionBtn();
}

async function saveCompletedState(item, completed) {
  try {
    const body = {
      filePath: item.path,
      completed: completed
    };
    
    // For video files, keep current time or reset to start if marking incomplete
    if (item.type === 'video') {
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
    
    item.progress = progressObj;
    syncCourseProgressMap(item.path, progressObj);
    
    renderActiveWorkspaceOutline();
    showToast(completed ? 'Lesson marked as completed!' : 'Lesson marked in-progress');
  } catch (err) {
    console.error(err);
    showToast('Failed to save completion state');
  }
}

// --- WORKSPACE NAV: PREV / NEXT ---
function getFlatItemsList() {
  const list = [];
  if (!state.currentCourse || !state.currentCourse.sections) return list;
  const activeTab = state.currentWorkspaceTab || 'lessons';
  const allowedTypes = activeTab === 'lessons'
    ? ['video', 'pdf', 'html', 'text']
    : ['image', 'code', 'other'];

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
  tableBody.innerHTML = '';

  state.config.folders.forEach(folder => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${folder}</td>
      <td style="text-align:right;">
        <button class="table-action-btn" onclick="removeFolder('${folder.replace(/'/g, "\\'")}')" title="Delete watched folder">
          <svg class="table-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </td>
    `;
    tableBody.appendChild(tr);
  });
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

function toggleSidebar() {
  const sidebar = document.getElementById('app-sidebar');
  if (!sidebar) return;
  
  const isCollapsed = sidebar.classList.toggle('collapsed');
  
  // Store state in localStorage
  localStorage.setItem('sidebar-collapsed', isCollapsed ? 'true' : 'false');
  
  // Update tooltip/title for both buttons
  const titleText = isCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar';
  const brandBtn = document.getElementById('brand-toggle-btn');
  const navBtn = document.getElementById('sidebar-toggle-btn');
  if (brandBtn) brandBtn.setAttribute('title', titleText);
  if (navBtn) navBtn.setAttribute('title', titleText);
}

