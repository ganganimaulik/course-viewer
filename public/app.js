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
  playbackRate: parseFloat(localStorage.getItem('playback-rate')) || 1.0,
  activity: { days: {}, courses: {}, weeklyGoalHours: 5 },
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
  initReadingProgress();
  initRouting(); // Shows the page for the address; course pages wait for the catalog
  refreshCatalog();
  
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
  initStudyTime();
  initHeatmapTooltip();
  initPanelSizes();

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
  tickStudyTime(); // Leaving the workspace stops the study timer
  state.view = viewId;

  // Pause video player if we leave workspace
  if (viewId !== 'workspace') {
    const video = document.getElementById('main-video-player');
    if (video && !video.paused) {
      video.pause();
    }
    cancelAutoplay();
    flushReadingPosition();
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
  } else if (viewId === 'search') {
    const input = document.getElementById('global-search-input');
    input.focus();
    input.select();
  }
  updateUrl();
}

// --- PAGE URLS ---
// Every page has its own address, so reloading, Back/Forward, bookmarks and opening links in new tabs all work:
//   /dashboard, /courses, /settings, /search?q=<words>&kind=<kind>
//   /courses/<course>                          a course with nothing open
//   /courses/<course>/<folder>/<lesson.ext>    a lesson or resource, by its path in the course folder
//                                              (lectures also take ?t=<seconds> to start from)
//   /courses/<course>/summary                  the course summary
// Names become slugs ("01 - What's Next.mp4" is "01-whats-next.mp4"), and "/" reopens the page open last time.
// The address is worked out from what's on screen (currentPage()), so the functions that change pages only
// call updateUrl(); routeTo() goes the other way, from an address to its page.
const PAGE_VIEWS = ['dashboard', 'courses', 'search', 'settings'];

// Lowercase words joined by hyphens: "Café – What's New?" is "cafe-whats-new". Letters of other scripts stay;
// emoji and other symbols go.
function slugify(text) {
  return text.normalize('NFKD')
    .replace(/[\u0300-\u036F]|['\u2019]/g, '') // Accents ("é" to "e") and apostrophes ("what's" to "whats")
    .replace(/[\uFE00-\uFE0F]|\p{Me}|(?<![\p{L}\p{N}\p{M}])\p{M}+/gu, '') // Emoji variation selectors, keycaps, marks on no letter
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');
}

// The first free one of slug, slug-2, slug-3... (an extension goes after the number: "intro-2.mp4")
function uniqueSlug(base, ext, used) {
  let slug = base + ext;
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}${ext}`;
  used.add(slug);
  return slug;
}

// Name each course, and each file by its path in the course folder. Courses take theirs in path order, so a
// course keeps its slug however the catalog is sorted; files go in the folder order the server sorts them in.
function assignSlugs(courses) {
  const courseSlugs = new Set();
  [...courses].sort((a, b) => (a.path < b.path ? -1 : 1)).forEach((course) => {
    course.slug = uniqueSlug(slugify(course.title) || 'course', '', courseSlugs);
    const used = new Set(['summary']); // The course summary's address
    course.sections.forEach(section => section.items.forEach((item) => {
      const folders = item.relativePath.split('/');
      const name = folders.pop();
      const dot = name.lastIndexOf('.');
      const ext = dot > 0 ? slugify(name.slice(dot + 1)) : '';
      const base = folders.map(folder => `${slugify(folder) || 'untitled'}/`).join('') +
        (slugify(dot > 0 ? name.slice(0, dot) : name) || 'untitled');
      item.slug = uniqueSlug(base, ext && `.${ext}`, used);
    }));
  });
}

function courseUrl(course) {
  return `/courses/${encodeURIComponent(course.slug)}`;
}

function itemUrl(course, item) {
  return `${courseUrl(course)}/${item.slug.split('/').map(encodeURIComponent).join('/')}`;
}

// The sidebar tab that lists an item
function itemTab(item) {
  return LESSON_TYPES.includes(item.type) ? 'lessons' : 'resources';
}

// The address and title of what's on screen (no address while a course page waits for the catalog)
function currentPage() {
  const course = state.currentCourse;
  if (state.view === 'workspace') {
    if (!course) return { url: null };
    if (state.currentWorkspaceTab === 'course-summary') {
      return { url: `${courseUrl(course)}/summary`, title: `Course Summary – ${course.title}` };
    }
    if (state.currentItem) {
      return { url: itemUrl(course, state.currentItem), title: `${state.currentItem.name} – ${course.title}` };
    }
    return { url: courseUrl(course), title: course.title };
  }
  if (state.view === 'search') {
    const query = document.getElementById('global-search-input').value.trim();
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    const kind = document.getElementById('global-search-kind').value;
    if (kind) params.set('kind', kind);
    return { url: params.toString() ? `/search?${params}` : '/search', title: query ? `Search: ${query}` : 'Search' };
  }
  const titles = { dashboard: 'Dashboard', courses: 'Course Catalog', settings: 'Settings' };
  return { url: `/${state.view}`, title: titles[state.view] };
}

// Show the page on screen in the address bar, once the steps that changed it are done: opening a course and then
// a lesson in it is one click, so one history entry. Back/Forward and corrected addresses replace the entry instead.
let pendingUrlUpdate = null;
function updateUrl(replace = false) {
  if (pendingUrlUpdate) {
    pendingUrlUpdate.replace = pendingUrlUpdate.replace || replace;
    return;
  }
  pendingUrlUpdate = { replace };
  queueMicrotask(() => {
    const { replace } = pendingUrlUpdate;
    pendingUrlUpdate = null;
    const { url, title } = currentPage();
    if (!url) return;
    if (url !== location.pathname + location.search) {
      // The title changes after the entry does: browsers label the entry with the title it has when it's left
      history[replace ? 'replaceState' : 'pushState'](null, '', url);
    }
    document.title = `${title} – Antigravity`;
    localStorage.setItem('last-url', url);
    // The Search link returns to the last search
    if (state.view === 'search') document.getElementById('nav-search').href = url;
  });
}

// What an address points at: a main page (with the search, for /search), or a course and the rest of the path
// for course pages. Null for addresses that aren't pages of the app.
function parseRoute(url) {
  const { pathname, searchParams } = new URL(url, location.origin);
  const parts = pathname.split('/').filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part).normalize('NFC').toLowerCase();
    } catch (err) {
      return part; // Not valid percent-encoding, so it can't match a slug
    }
  });
  if (parts.length === 0) return { view: 'resume' };
  if (parts.length === 1 && PAGE_VIEWS.includes(parts[0])) {
    return { view: parts[0], query: searchParams.get('q') || '', kind: searchParams.get('kind') || '' };
  }
  if (parts.length > 1 && parts[0] === 'courses') {
    return { view: 'workspace', course: parts[1], path: parts.slice(2).join('/'), time: parseFloat(searchParams.get('t')) };
  }
  return null;
}

// Show the page for an address: on load, on Back/Forward, and for app links. replace keeps the history entry.
function routeTo(url, { replace = false } = {}) {
  const route = parseRoute(url);
  state.awaitingCatalog = false;
  if (replace) updateUrl(true);

  if (route && route.view === 'resume') {
    const last = localStorage.getItem('last-url');
    const lastRoute = last && last.startsWith('/') ? parseRoute(last) : null;
    if (lastRoute && lastRoute.view !== 'resume') {
      history.replaceState(null, '', last);
      routeTo(last, { replace: true });
    } else {
      switchView('dashboard');
    }
    return;
  }
  if (!route) {
    switchView('dashboard');
    updateUrl(true);
    return;
  }

  if (route.view === 'search') {
    const input = document.getElementById('global-search-input');
    const kindSelect = document.getElementById('global-search-kind');
    const shown = state.searchShown;
    input.value = route.query;
    kindSelect.value = route.kind;
    if (kindSelect.selectedIndex === -1) kindSelect.value = '';
    switchView('search');
    // Results link to lessons by their slugs, which need the catalog. Back to a search keeps its results.
    if (!state.coursesLoaded) {
      state.awaitingCatalog = true;
    } else if (!shown || shown.query !== input.value.trim() || shown.kind !== kindSelect.value) {
      runGlobalSearch();
    }
    return;
  }
  if (route.view !== 'workspace') {
    switchView(route.view);
    return;
  }

  if (!state.coursesLoaded) {
    switchView('workspace'); // "Loading Course..." until refreshCatalog() routes here again
    state.awaitingCatalog = true;
    return;
  }
  const course = state.courses.find(c => c.slug === route.course);
  if (!course) {
    showToast("That course isn't in your watched folders");
    switchView('courses');
    updateUrl(true);
    return;
  }
  let item = null;
  let section = null;
  if (route.path && route.path !== 'summary') {
    for (const sec of course.sections) {
      item = sec.items.find(i => i.slug === route.path);
      if (item) {
        section = sec;
        break;
      }
    }
    if (!item) {
      showToast("That lesson isn't in the course folder");
      updateUrl(true); // The course's own page replaces the address
    }
  }
  const tab = route.path === 'summary' ? 'course-summary' : (item ? itemTab(item) : 'lessons');
  const startAt = item && isMediaItem(item) && Number.isFinite(route.time) && route.time >= 0 ? route.time : null;

  if (state.view !== 'workspace' || !state.currentCourse || state.currentCourse.id !== course.id) {
    if (startAt !== null) state.pendingSeekTime = startAt;
    openCourse(course.id, item ? item.path : null, tab);
  } else if (tab === 'course-summary') {
    if (state.currentWorkspaceTab !== tab) switchWorkspaceTab(tab);
  } else if (!item) {
    openCourse(course.id, null, tab); // Closes the open lesson
  } else if (state.currentItem && state.currentItem.path === item.path) {
    // Already open, e.g. Back from the course summary: show it again without reloading it
    if (state.currentWorkspaceTab !== tab) switchWorkspaceTab(tab);
    if (startAt !== null) seekCurrentMedia(startAt);
  } else {
    // Another lesson of the open course: the outline keeps its filter (switching tabs would clear it)
    if (state.currentWorkspaceTab !== tab) switchWorkspaceTab(tab);
    if (startAt !== null) state.pendingSeekTime = startAt;
    selectItem(item, section);
  }
}

// App links open their page here; Cmd/Ctrl/Shift-click and the middle button still open a new tab or window
function handleAppLinkClick(event) {
  const link = event.target.closest('a[href]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (link.target || link.hasAttribute('download') || link.origin !== location.origin || !parseRoute(link.href)) return;
  // A link to a heading on this page (e.g. in a Markdown lesson) just scrolls there
  if (link.hash && link.pathname === location.pathname && link.search === location.search) return;
  event.preventDefault();
  routeTo(link.href);
}

function initRouting() {
  window.addEventListener('popstate', () => routeTo(location.href, { replace: true }));
  document.addEventListener('click', handleAppLinkClick);
  routeTo(location.href, { replace: true });
}

// --- FETCH & DATA SYNC ---
async function refreshCatalog() {
  const refreshBtn = document.getElementById('refresh-courses-btn');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = `Scanning...`;
  }
  
  try {
    // Fetch watch folders config
    const configRes = await fetch(`/api/config`);
    state.config = await configRes.json();

    // Fetch AI services configuration
    try {
      const aiRes = await fetch(`/api/ai-config`);
      state.aiConfig = await aiRes.json();
    } catch (e) {
      console.warn('Error loading AI config:', e);
    }

    // Fetch study time history and the weekly goal
    try {
      const activityRes = await fetch(`/api/activity`);
      state.activity = await activityRes.json();
    } catch (e) {
      console.warn('Error loading study time:', e);
    }
    
    // Fetch courses with merged progress
    const coursesRes = await fetch(`/api/courses`);
    state.courses = await coursesRes.json();
    assignSlugs(state.courses);
    state.coursesLoaded = true;

    renderDashboard();
    renderFullCatalog();
    renderSettings();
    watchMediaDurations();

    // If we have an active course open, update its state from the refreshed courses list
    if (state.currentCourse) {
      const updatedCourse = state.courses.find(c => c.id === state.currentCourse.id);
      if (updatedCourse) {
        state.currentCourse = updatedCourse;
        // Refresh the open item too, so its progress isn't stale (e.g. after a reset). It keeps its object, with the
        // refreshed fields copied in: the player and the page and PDF trackers hold on to it
        if (state.currentItem) {
          for (const sec of updatedCourse.sections) {
            const index = sec.items.findIndex(i => i.path === state.currentItem.path);
            if (index !== -1) {
              const item = state.currentItem;
              Object.keys(item).forEach(key => delete item[key]);
              Object.assign(item, sec.items[index]);
              sec.items[index] = item;
              state.currentSection = sec;
              break;
            }
          }
          updateHeaderActionBtn();
        }
        document.getElementById('workspace-course-progress').textContent = workspaceProgressText(updatedCourse);
        const watchBtn = document.getElementById('btn-watch-course');
        if (watchBtn) {
          watchBtn.style.display = updatedCourse.progressPercent === 100 ? 'none' : '';
        }
        renderActiveWorkspaceOutline();
      }
    }

    // Show the page that was waiting for the catalog, or keep the open course's address in step with its slugs
    if (state.awaitingCatalog) {
      routeTo(location.href, { replace: true });
    } else if (state.view === 'workspace') {
      updateUrl(true);
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
  if (!state.coursesLoaded) return; // Rendered once the catalog has loaded, rather than as empty

  // 1. Statistics
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
          if (item.progress.completed || item.progress.skipped) {
            completedCount++;
          }
          recentFiles.push({
            ...item,
            courseTitle: course.title,
            courseId: course.id,
            url: itemUrl(course, item)
          });
        }
      });
    });
  });

  renderStudyStats();
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
      const card = document.createElement('a');
      card.className = 'resume-card';
      card.href = item.url;

      const percent = item.progress.percent || 0;
      let progressLabel = '';
      if (item.progress.skipped) {
        progressLabel = 'Skipped';
      } else if (isMediaItem(item)) {
        progressLabel = `${formatTime(item.progress.currentTime)} / ${formatTime(item.progress.duration)} (${percent}%)`;
      } else if (item.progress.completed) {
        progressLabel = 'Completed';
      } else if (item.progress.pages) {
        progressLabel = `Page ${item.progress.page} of ${item.progress.pages}`;
      } else if (item.progress.scroll !== undefined) {
        progressLabel = `${percent}% read`;
      } else {
        progressLabel = 'Started';
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
  if (!state.coursesLoaded) return; // As in renderDashboard
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
    const timeText = courseTimeText(c);

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
      <a class="course-title" href="${courseUrl(c)}" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</a>
      <div class="course-meta">
        ${timeText ? `
        <div class="course-meta-row course-time-row">
          <svg class="meta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span>${escapeHtml(timeText)}</span>
        </div>` : ''}
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

// --- STUDY TIME ---
// Real time spent with lessons (not media time), reported per day and course: while a video or audio lesson
// plays, or while a page, PDF or document is on screen and the reader has done something in the last 5 minutes.
const STUDY_IDLE_MS = 5 * 60 * 1000;
// Reading only counts after some input, so a lesson page reopened on load doesn't count on its own
const studyTime = { lastTick: performance.now(), lastInputAt: 0, studying: null, pending: new Map() };

function noteStudyInput() {
  studyTime.lastInputAt = Date.now();
}

function isStudying() {
  const item = state.currentItem;
  if (!item || state.view !== 'workspace' || state.currentWorkspaceTab === 'course-summary') return false;
  if (isMediaItem(item)) {
    const video = document.getElementById('main-video-player');
    return state.videoItem === item && !video.paused && !video.ended;
  }
  return document.visibilityState === 'visible' && Date.now() - studyTime.lastInputAt < STUDY_IDLE_MS;
}

// Credit the time since the last tick to whatever was being studied when it began. Called on a timer and
// whenever that could change (play, pause, switching lessons or views).
function tickStudyTime() {
  const now = performance.now();
  // Capped, so a laptop waking from sleep doesn't log the time it was asleep
  const elapsed = Math.min(120, (now - studyTime.lastTick) / 1000);
  studyTime.lastTick = now;
  const studied = studyTime.studying;
  if (studied && elapsed > 0) {
    const entry = studyTime.pending.get(studied.path) || { seconds: 0, courseId: studied.courseId };
    entry.seconds += elapsed;
    studyTime.pending.set(studied.path, entry);
  }
  studyTime.studying = isStudying() ? { path: state.currentItem.path, courseId: state.currentCourse.id } : null;
}

function flushStudyTime() {
  tickStudyTime();
  const today = localDateKey(new Date());
  let logged = false;
  for (const [filePath, entry] of studyTime.pending) {
    if (entry.seconds < 1) continue;
    studyTime.pending.delete(filePath);
    logged = true;
    let seconds = Math.round(entry.seconds);
    state.activity.days[today] = (state.activity.days[today] || 0) + seconds;
    state.activity.courses[entry.courseId] = (state.activity.courses[entry.courseId] || 0) + seconds;
    // The server takes at most 300 seconds per report
    while (seconds > 0) {
      const chunk = Math.min(300, seconds);
      seconds -= chunk;
      fetch(`/api/activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, seconds: chunk }),
        keepalive: true // Still sent if this runs as the tab closes
      }).catch(err => console.error('Error saving study time:', err));
    }
  }
  if (logged) renderStudyStats();
}

function initStudyTime() {
  ['mousemove', 'keydown', 'wheel', 'pointerdown', 'touchstart'].forEach((type) => {
    document.addEventListener(type, noteStudyInput, { passive: true });
  });
  document.addEventListener('visibilitychange', tickStudyTime);
  window.addEventListener('pagehide', flushStudyTime);
  setInterval(tickStudyTime, 5000);
  setInterval(flushStudyTime, 60000);
}

// Local calendar date, e.g. "2026-11-01" (matches localDateKey in server.js)
function localDateKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// "45m", "1h 20m", "12h"
function formatStudyTime(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

const HEATMAP_WEEKS = 26;
// A day counts toward a streak, and shows on the heatmap, after a minute of study
const STUDY_DAY_MIN_SECONDS = 60;

// Heatmap level for a day: 0 below a minute, then up to 15m, 45m, 90m and beyond
function heatLevel(seconds) {
  if (seconds < STUDY_DAY_MIN_SECONDS) return 0;
  if (seconds < 15 * 60) return 1;
  if (seconds < 45 * 60) return 2;
  if (seconds < 90 * 60) return 3;
  return 4;
}

// Time studied in the sidebar, and the dashboard's Study Activity panel
function renderStudyStats() {
  const totalStudied = Object.values(state.activity.days || {}).reduce((sum, seconds) => sum + seconds, 0);
  document.getElementById('stat-hours').textContent = `${(totalStudied / 3600).toFixed(1)}h`;
  renderStudyActivity();
}

function renderStudyActivity() {
  const days = state.activity.days || {};
  const goalHours = state.activity.weeklyGoalHours || 5;
  const studied = (date) => (days[localDateKey(date)] || 0) >= STUDY_DAY_MIN_SECONDS;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const addDays = (date, n) => {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  };

  document.getElementById('study-today').textContent = formatStudyTime(days[localDateKey(today)] || 0);

  // This week, Monday to today, against the goal
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  let weekSeconds = 0;
  for (let d = monday; d <= today; d = addDays(d, 1)) weekSeconds += days[localDateKey(d)] || 0;
  document.getElementById('study-week-text').textContent = `${formatStudyTime(weekSeconds)} of ${goalHours}h`;
  document.getElementById('study-week-bar').style.width = `${Math.min(100, (weekSeconds / (goalHours * 3600)) * 100)}%`;

  // Streaks: the current one still counts until the end of today, so it doesn't read 0 before studying
  let streak = 0;
  for (let d = studied(today) ? today : addDays(today, -1); studied(d); d = addDays(d, -1)) streak++;
  let best = 0;
  let run = 0;
  let previous = null;
  Object.keys(days).filter(key => days[key] >= STUDY_DAY_MIN_SECONDS).sort().forEach((key) => {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    run = previous && localDateKey(addDays(previous, 1)) === key ? run + 1 : 1;
    best = Math.max(best, run);
    previous = date;
  });
  document.getElementById('study-streak').textContent = `${streak} ${streak === 1 ? 'day' : 'days'}`;
  document.getElementById('study-streak-best').textContent = `Best: ${best} ${best === 1 ? 'day' : 'days'}`;

  // Heatmap: one column per week, Monday at the top, ending with this week
  const grid = document.getElementById('study-heatmap');
  const months = document.getElementById('study-heatmap-months');
  grid.innerHTML = '';
  months.innerHTML = '';
  const start = addDays(monday, -(HEATMAP_WEEKS - 1) * 7);
  let daysStudied = 0;
  let total = 0;
  let lastLabelColumn = -3;
  for (let week = 0; week < HEATMAP_WEEKS; week++) {
    const weekStart = addDays(start, week * 7);
    // Label a column where a new month starts (skipping labels that would crowd the previous one)
    const monthStarts = week === 0 || weekStart.getMonth() !== addDays(weekStart, -7).getMonth();
    if (monthStarts && week - lastLabelColumn >= 3) {
      const label = document.createElement('span');
      label.textContent = weekStart.toLocaleDateString(undefined, { month: 'short' });
      label.style.gridColumn = String(week + 1);
      months.appendChild(label);
      lastLabelColumn = week;
    }
    for (let day = 0; day < 7; day++) {
      const date = addDays(weekStart, day);
      const cell = document.createElement('div');
      if (date > today) {
        cell.className = 'heat-cell future';
      } else {
        const seconds = days[localDateKey(date)] || 0;
        cell.className = `heat-cell level-${heatLevel(seconds)}`;
        cell.dataset.label = `${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${seconds >= STUDY_DAY_MIN_SECONDS ? formatStudyTime(seconds) : 'No study'}`;
        if (seconds >= STUDY_DAY_MIN_SECONDS) daysStudied++;
        total += seconds;
      }
      grid.appendChild(cell);
    }
  }
  grid.setAttribute('aria-label', `Study time over the last ${HEATMAP_WEEKS} weeks: ${daysStudied} days studied, ${formatStudyTime(total)} in total`);
}

// Heatmap tooltip, placed above the hovered day
function initHeatmapTooltip() {
  const grid = document.getElementById('study-heatmap');
  const tooltip = document.getElementById('study-heatmap-tooltip');
  grid.addEventListener('mouseover', (event) => {
    const cell = event.target.closest('.heat-cell');
    if (!cell || !cell.dataset.label) return;
    tooltip.textContent = cell.dataset.label;
    tooltip.style.display = 'block';
    const card = tooltip.offsetParent.getBoundingClientRect();
    const box = cell.getBoundingClientRect();
    const left = Math.min(Math.max(box.left + box.width / 2 - card.left, tooltip.offsetWidth / 2), card.width - tooltip.offsetWidth / 2);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${box.top - card.top - 8}px`;
  });
  grid.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
}

async function saveWeeklyGoal() {
  const input = document.getElementById('weekly-goal-input');
  try {
    const res = await fetch(`/api/activity/goal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weeklyGoalHours: parseFloat(input.value) })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save the goal');
    state.activity.weeklyGoalHours = data.weeklyGoalHours;
    showToast(`Weekly goal set to ${data.weeklyGoalHours}h`);
  } catch (err) {
    showToast(err.message);
  }
}

// --- COURSE LENGTH ---
// Total length of a course's video and audio, and how much is left at the current playback speed. Lengths
// come from the server measuring files in the background, or from having played the lesson.
function getCourseTime(course) {
  let total = 0;
  let left = 0;
  let unknown = 0;
  course.sections.forEach(sec => sec.items.forEach(item => {
    if (!isMediaItem(item)) return;
    const prog = item.progress;
    const duration = item.duration || (prog && prog.duration);
    if (!duration) {
      if (item.duration !== null) unknown++; // null: unreadable, so it won't be measured
      return;
    }
    total += duration;
    if (!prog || (!prog.completed && !prog.skipped)) {
      left += Math.max(0, duration - ((prog && prog.currentTime) || 0));
    }
  }));
  return { total, left: left / state.playbackRate, unknown };
}

function formatRate(rate) {
  return `${+rate.toFixed(2)}x`;
}

// "14h 20m total · 6h 5m left at 1.5x", prefixed with ≈ while some lengths are still being measured
function courseTimeText(course) {
  const { total, left, unknown } = getCourseTime(course);
  if (!total) return '';
  const speed = state.playbackRate !== 1 ? ` at ${formatRate(state.playbackRate)}` : '';
  const remaining = left >= 60 ? `${formatStudyTime(left)} left${speed}` : 'all watched';
  return `${unknown > 0 ? '≈ ' : ''}${formatStudyTime(total)} total · ${remaining}`;
}

function workspaceProgressText(course) {
  const { left } = getCourseTime(course);
  return `${course.progressPercent}% Completed${left >= 60 ? ` · ${formatStudyTime(left)} left` : ''}`;
}

// While the server measures a new library, fill in lengths as they arrive (each poll asks only for the ones
// measured since the last)
function watchMediaDurations() {
  const missing = state.courses.some(c => c.sections.some(s => s.items.some(i => isMediaItem(i) && i.duration === undefined)));
  if (state.durationsTimer || !missing) return;
  const startedAt = Date.now();
  let from = 0;
  state.durationsTimer = setInterval(async () => {
    try {
      const { durations, pending, next } = await (await fetch(`/api/media/durations?from=${from}`)).json();
      if (next < from) {
        from = 0; // The server restarted, so its count started over: ask again for everything
        return;
      }
      from = next;
      let changed = false;
      state.courses.forEach(c => c.sections.forEach(s => s.items.forEach(i => {
        if (!isMediaItem(i)) return;
        if (i.path in durations && i.duration !== durations[i.path]) {
          i.duration = durations[i.path];
          changed = true;
        } else if (pending === 0 && i.duration === undefined) {
          i.duration = null; // Nothing is left to measure, so this one can't be (e.g. ffprobe isn't installed)
          changed = true;
        }
      })));
      if (changed) {
        if (state.view === 'dashboard') renderDashboard();
        else if (state.view === 'courses') renderFullCatalog();
        if (state.currentCourse) {
          document.getElementById('workspace-course-progress').textContent = workspaceProgressText(state.currentCourse);
        }
      }
      if (pending === 0 || Date.now() - startedAt > 10 * 60 * 1000) {
        clearInterval(state.durationsTimer);
        state.durationsTimer = null;
      }
    } catch (err) {
      console.error('Error loading lesson lengths:', err);
    }
  }, 8000);
}

// --- SEARCH ---
const SEARCH_KIND_LABELS = { title: 'Lesson name', transcript: 'Transcript', notes: 'AI notes', page: 'Lesson page', 'course-notes': 'Course summary' };
let searchRequest = null;
let searchTimer = null;

function onGlobalSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runGlobalSearch, 250);
}

async function runGlobalSearch() {
  clearTimeout(searchTimer);
  const query = document.getElementById('global-search-input').value.trim();
  const kind = document.getElementById('global-search-kind').value;
  const status = document.getElementById('global-search-status');
  if (searchRequest) searchRequest.abort(); // Superseded by what's typed now
  // The address follows the search, replacing its history entry rather than adding one per word typed
  if (state.view === 'search') updateUrl(true);
  if (!query) {
    status.textContent = '';
    renderSearchResults([]);
    state.searchShown = { query, kind };
    return;
  }

  searchRequest = new AbortController();
  try {
    const params = new URLSearchParams({ q: query });
    if (kind) params.set('kind', kind);
    const res = await fetch(`/api/search?${params}`, { signal: searchRequest.signal });
    const data = await res.json();
    renderSearchResults(data.results);
    state.searchShown = { query, kind }; // What routeTo finds already on screen when Back returns here
    status.textContent = data.total === 0 ? 'No matches.' : `${data.total} ${data.total === 1 ? 'lesson matches' : 'lessons match'}${data.total > data.results.length ? `; showing the top ${data.results.length}` : ''}.`;
    if (data.indexing) {
      const progress = data.progress ? ` (${data.progress.done} of ${data.progress.total} files)` : '';
      status.textContent += ` Building the search index${progress}, so results may be incomplete...`;
      searchTimer = setTimeout(runGlobalSearch, 3000); // Search again as the index fills in
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Search failed:', err);
    status.textContent = 'Search failed. Is the server running?';
  }
}

// Text with the matched words wrapped in <mark>, built from text nodes so nothing in it is parsed as HTML
function appendHighlighted(el, text, ranges) {
  let pos = 0;
  for (const [start, end] of ranges) {
    if (start > pos) el.append(text.slice(pos, start));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(start, end);
    el.append(mark);
    pos = end;
  }
  el.append(text.slice(pos));
}

function renderSearchResults(results) {
  const list = document.getElementById('global-search-results');
  list.innerHTML = '';
  results.forEach((result) => {
    // A link to the result's page, unless it has left the catalog since this page loaded
    const url = searchResultUrl(result);
    const card = document.createElement(url ? 'a' : 'button');
    card.className = 'search-result';
    if (url) {
      card.href = url;
    } else {
      card.type = 'button';
      card.addEventListener('click', () => showToast(state.courses.some(c => c.id === result.courseId)
        ? 'That lesson is no longer in the course folder'
        : 'That course is no longer in your watched folders'));
    }

    const meta = document.createElement('div');
    meta.className = 'search-result-meta';
    meta.textContent = [result.courseTitle, result.sectionName && result.sectionName !== 'General' ? result.sectionName : null].filter(Boolean).join(' / ');

    const title = document.createElement('div');
    title.className = 'search-result-title';
    title.textContent = result.itemName || 'Course summary';

    const badges = document.createElement('div');
    badges.className = 'search-result-badges';
    const kindBadge = document.createElement('span');
    kindBadge.className = 'search-badge';
    kindBadge.textContent = SEARCH_KIND_LABELS[result.kind] || result.kind;
    badges.appendChild(kindBadge);
    if (result.start !== null) {
      const time = document.createElement('span');
      time.className = 'search-badge time';
      time.textContent = `Plays from ${formatTime(result.start)}`;
      badges.appendChild(time);
    }
    if (result.matches > 1) {
      const more = document.createElement('span');
      more.className = 'search-result-more';
      more.textContent = `+${result.matches - 1} more ${result.matches === 2 ? 'match' : 'matches'} in this lesson`;
      badges.appendChild(more);
    }

    const snippet = document.createElement('p');
    snippet.className = 'search-result-snippet';
    appendHighlighted(snippet, result.snippet, result.highlights);

    card.append(meta, title, badges, snippet);
    list.appendChild(card);
  });
}

// Where a result opens: its lesson, at the matching moment for lectures (or the course summary). Null when its
// course or lesson isn't in the catalog any more.
function searchResultUrl(result) {
  const course = state.courses.find(c => c.id === result.courseId);
  if (!course) return null;
  if (!result.filePath) return `${courseUrl(course)}/summary`;
  const item = course.sections.flatMap(s => s.items).find(i => i.path === result.filePath);
  if (!item) return null;
  return result.start !== null && isMediaItem(item) ? `${itemUrl(course, item)}?t=${Math.floor(result.start)}` : itemUrl(course, item);
}

// --- ================== WORKSPACE VIEW ACTIONS ================== ---

// Open Course outline view, on the given sidebar tab, with an item open (see routeTo)
function openCourse(courseId, restoreItemPath = null, tab = 'lessons') {
  const course = state.courses.find(c => c.id === courseId);
  if (!course) return;

  // Stop the open lesson: Back/Forward from a lesson to another course or its course's page stays in the
  // workspace, where switchView doesn't pause it. Its position is saved now, since loading another video
  // drops the queued pause event (as in selectItem).
  flushReadingPosition();
  tickStudyTime();
  stopProgressInterval();
  cancelAutoplay();
  const video = document.getElementById('main-video-player');
  if (!video.paused) {
    video.pause();
    saveVideoProgress(true);
  }

  // Another course starts a new conversation; reopening this one (e.g. with Back) keeps it
  if (!state.currentCourse || state.currentCourse.id !== courseId) {
    state.courseChatHistory = [];
    renderCourseChatMessages(); // Clear the previous course's conversation from the panel

    const summaryLayout = document.getElementById('course-summary-layout');
    if (summaryLayout && summaryLayout.classList.contains('chat-open')) toggleCourseChat(); // Closes the chat panel
    const toggleBtn = document.getElementById('btn-toggle-course-chat');
    if (toggleBtn) toggleBtn.style.display = 'none';
  }

  state.currentCourse = course;
  // Nothing is open yet in this course; an item left over from the previous course would otherwise
  // reappear (with its breadcrumbs) when switching sidebar tabs
  state.currentItem = null;
  state.currentSection = null;
  switchView('workspace');

  document.getElementById('workspace-course-title').textContent = course.title;
  document.getElementById('workspace-course-progress').textContent = workspaceProgressText(course);
  
  const watchBtn = document.getElementById('btn-watch-course');
  if (watchBtn) {
    watchBtn.style.display = course.progressPercent === 100 ? 'none' : '';
  }
  
  switchWorkspaceTab(tab);

  if (tab !== 'course-summary') {
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
  if (tab !== 'course-summary' && !restoreItemPath) {
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
      // A link to the item's page (see routeTo), which opens it in the viewer
      const itemRow = document.createElement('a');
      itemRow.className = 'outline-item';
      itemRow.href = itemUrl(state.currentCourse, item);
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
      const itemRow = document.createElement('a');
      itemRow.className = 'outline-item';
      itemRow.href = itemUrl(state.currentCourse, item);
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

      content.appendChild(itemRow);
    });

    acc.appendChild(content);
    resourceList.appendChild(acc);
  });
}

function switchWorkspaceTab(tabName) {
  if (tabName !== 'lessons' && tabName !== 'resources' && tabName !== 'course-summary') return;
  state.currentWorkspaceTab = tabName;

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
  updateUrl();
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

// Scroll the outline to the open lesson, e.g. one opened from its address, Back/Forward or autoplay, opening its folder
// if it was collapsed. Scrolls the list itself: scrollIntoView would also scroll the app's overflow-hidden containers.
function revealActiveOutlineItem() {
  const row = document.querySelector('.outline-item.active');
  const list = row && row.closest('.outline-scroller');
  if (!list || !list.clientHeight) return; // No open lesson in the outline, or its tab isn't showing
  row.closest('.section-accordion').classList.remove('collapsed');
  const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top; // From the top of the visible part
  const bottom = top + row.offsetHeight;
  if (bottom <= 0 || top >= list.clientHeight) {
    list.scrollTop += top - (list.clientHeight - row.offsetHeight) / 2; // Off screen: bring it to the middle
  } else if (top < 0) {
    list.scrollTop += top; // Partly cut off (e.g. a row clicked at the edge): just show all of it
  } else if (bottom > list.clientHeight) {
    list.scrollTop += bottom - list.clientHeight;
  }
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
  flushReadingPosition(); // Save where the previous page or PDF was left
  tickStudyTime(); // Credit time spent on the previous lesson

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
  revealActiveOutlineItem();

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
    loadPdfViewer(item);
    saveItemStarted(item);
  } else if (item.type === 'html') {
    const iframe = document.getElementById('html-frame');
    iframe.src = `/api/file?path=${encodeURIComponent(item.path)}`;
    watchLessonFrame(item);
    saveItemStarted(item);
  } else if (item.type === 'docx') {
    const iframe = document.getElementById('html-frame');
    iframe.src = `/api/docx?path=${encodeURIComponent(item.path)}`;
    watchLessonFrame(item);
    saveItemStarted(item);
  } else if (item.type === 'text') {
    loadTextViewer(item);
  } else if (item.type === 'image') {
    const imgElement = document.getElementById('image-view-element');
    imgElement.src = `/api/file?path=${encodeURIComponent(item.path)}`;
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

  tickStudyTime(); // Start crediting the new lesson
  updateUrl();
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
    tickStudyTime();
    
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
    tickStudyTime();
    
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
    updateTranscriptHighlight(video.currentTime);
  });

  // Follow-along scrolling pauses while the reader scrolls the transcript themselves
  const transcriptBody = document.getElementById('transcript-body');
  ['wheel', 'touchmove', 'mousedown', 'keydown'].forEach((type) => {
    transcriptBody.addEventListener(type, () => { state.transcriptScrolledAt = Date.now(); }, { passive: true });
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
  source.src = `/api/video?path=${encodeURIComponent(item.path)}`;
  // A source that fails to load reports it here, not on the <video>
  source.addEventListener('error', () => showMediaError(item));
  video.appendChild(source);

  // Audio has no picture, so show what's playing where it would be
  document.getElementById('audio-artwork').style.display = item.type === 'audio' ? 'flex' : 'none';
  document.getElementById('audio-artwork-title').textContent = item.name;
  setMediaStatus(item.remux ? 'Converting this video so the browser can play it (first time only)...' : null);

  // If subtitle track is present
  if (item.subtitlePath) {
    addCaptionsTrack(video, item.subtitlePath);
  }

  video.load();
  video.play().catch(e => console.log("Autoplay blocked by browser. User gesture required."));
}

function addCaptionsTrack(video, subtitlePath) {
  const track = document.createElement('track');
  track.src = `/api/subtitle?path=${encodeURIComponent(subtitlePath)}`;
  track.kind = 'captions';
  track.srclang = 'en';
  track.label = 'English';
  track.default = true;
  video.appendChild(track);
  // "default" only applies to tracks present when the media loads; captions made mid-lesson start hidden
  track.track.mode = 'showing';
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

    // "/" opens search from anywhere
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      switchView('search');
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
  localStorage.setItem('playback-rate', String(rate));
  const video = document.getElementById('main-video-player');
  video.playbackRate = rate;
  if (state.currentCourse) {
    document.getElementById('workspace-course-progress').textContent = workspaceProgressText(state.currentCourse);
  }
  
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
      const res = await fetch(`/api/progress`, {
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
    document.getElementById('workspace-course-progress').textContent = workspaceProgressText(updated);
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
    const res = await fetch(`/api/file?path=${encodeURIComponent(item.path)}`);
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
    const res = await fetch(`/api/progress`, {
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

// --- READING PROGRESS (pages, Word documents and PDFs) ---
// Pages remember how far they're scrolled and PDFs which page is open; reaching the end completes the lesson.

// Save the latest position once the reader pauses, or right away when they move on
function queueReadingPosition(item, position) {
  state.pendingReadingPosition = { item, position };
  clearTimeout(state.readingSaveTimer);
  state.readingSaveTimer = setTimeout(flushReadingPosition, 1200);
}

async function flushReadingPosition() {
  clearTimeout(state.readingSaveTimer);
  const pending = state.pendingReadingPosition;
  if (!pending) return;
  state.pendingReadingPosition = null;
  try {
    const res = await fetch(`/api/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: pending.item.path, ...pending.position }),
      keepalive: true // Still sent if this runs as the tab closes
    });
    const progressObj = await res.json();
    syncCourseProgressMap(pending.item.path, progressObj);
    pending.item.progress = progressObj;
    if (state.currentItem === pending.item) updateHeaderActionBtn();
  } catch (err) {
    console.error('Error saving reading position:', err);
  }
}

// The element that scrolls a page: usually the page itself, but saved web apps sometimes scroll an inner panel
function findScrollContainer(doc) {
  const root = doc.scrollingElement || doc.documentElement;
  if (root.scrollHeight - root.clientHeight > 40) return root;
  let best = null;
  let bestRange = 40;
  for (const el of doc.body.querySelectorAll('*')) {
    const range = el.scrollHeight - el.clientHeight;
    if (range > bestRange && /(auto|scroll)/.test(doc.defaultView.getComputedStyle(el).overflowY)) {
      best = el;
      bestRange = range;
    }
  }
  return best;
}

const trackedPages = new WeakSet();

// Lesson pages and Word documents load in the same-origin frame, so the app can follow their scrolling
// (their own scripts are blocked, see LESSON_PAGE_POLICY in server.js)
function trackPageScroll(item, doc) {
  trackedPages.add(doc);

  // Only scrolling the reader does counts: late styles and images also move the page, and could otherwise
  // make it look finished
  let interacted = false;
  // A page with nothing to scroll is read once the reader does something on it. That's checked only after it has
  // fully loaded, since late styles and images can still make it longer.
  let fitChecked = false;
  const completeIfItFits = () => {
    if (fitChecked || !interacted || doc.readyState !== 'complete' || state.currentItem !== item) return;
    fitChecked = true;
    if (!(item.progress && item.progress.completed) && !findScrollContainer(doc)) {
      queueReadingPosition(item, { scroll: 1 });
    }
  };
  ['wheel', 'keydown', 'touchstart', 'mousedown'].forEach((type) => {
    doc.addEventListener(type, () => {
      interacted = true;
      noteStudyInput();
      completeIfItFits();
    }, { passive: true, capture: true });
  });
  doc.defaultView.addEventListener('load', completeIfItFits, { once: true });
  // Input inside the frame doesn't reach the app's own listeners, which keep the study timer going
  doc.addEventListener('mousemove', noteStudyInput, { passive: true });

  // Reopen where the reader left off, unless the lesson is done. Done again once the page has fully loaded,
  // since late styles and images move things around, unless the reader has started scrolling by then.
  const restore = () => {
    const saved = item.progress && item.progress.scroll;
    if (!saved || item.progress.completed || interacted) return;
    const container = findScrollContainer(doc);
    if (container) container.scrollTop = saved * (container.scrollHeight - container.clientHeight);
  };
  restore();
  doc.defaultView.addEventListener('load', restore, { once: true });

  // Scroll events don't bubble, so listen while they're captured, then keep only the page's main scroller's
  let container = null;
  doc.addEventListener('scroll', (event) => {
    if (state.currentItem !== item || !interacted) return;
    container = container || findScrollContainer(doc);
    const source = event.target === doc ? doc.scrollingElement : event.target;
    if (!container || source !== container) return;
    const range = container.scrollHeight - container.clientHeight;
    queueReadingPosition(item, { scroll: range > 0 ? Math.min(1, container.scrollTop / range) : 1 });
  }, { passive: true, capture: true });
}

// Start tracking a page as soon as its DOM is ready: saved course pages can take a long time to fire "load",
// since that waits for their embedded players and remote images
function watchLessonFrame(item) {
  const frame = document.getElementById('html-frame');
  const src = frame.src;
  const startedAt = Date.now();
  clearInterval(state.lessonFrameTimer);
  state.lessonFrameTimer = setInterval(() => {
    if (state.currentItem !== item || Date.now() - startedAt > 30000) {
      clearInterval(state.lessonFrameTimer);
      return;
    }
    // Until the new page commits, the frame still holds the previous one (already tracked, if it's this lesson)
    const doc = frame.contentDocument; // null once a link has taken the frame to another site
    if (doc && doc.body && doc.readyState !== 'loading' && doc.location.href === src && !trackedPages.has(doc)) {
      clearInterval(state.lessonFrameTimer);
      trackPageScroll(item, doc);
    }
  }, 150);
}

function initReadingProgress() {
  window.addEventListener('pagehide', flushReadingPosition);
}

// PDF.js renders PDFs in the page (instead of the browser's viewer, which can't say what page is open).
// It loads from the CDN the first time a PDF is opened.
const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299';
const pdfState = { viewer: null, item: null, loadingTask: null, ready: false, fitWidth: true };
let pdfViewerReady = null;

function getPdfViewer() {
  if (!pdfViewerReady) {
    pdfViewerReady = (async () => {
      const pdfjsLib = await import(`${PDFJS_BASE}/build/pdf.min.mjs`);
      pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.min.mjs`;
      globalThis.pdfjsLib = pdfjsLib; // pdf_viewer.mjs looks for the library here
      const viewerLib = await import(`${PDFJS_BASE}/web/pdf_viewer.mjs`);

      const container = document.getElementById('pdf-scroll-container');
      const eventBus = new viewerLib.EventBus();
      // Links in a PDF open in a new tab rather than navigating away from the app
      const linkService = new viewerLib.PDFLinkService({ eventBus, externalLinkTarget: viewerLib.LinkTarget.BLANK });
      const viewer = new viewerLib.PDFViewer({ container, viewer: document.getElementById('pdf-viewer'), eventBus, linkService });
      linkService.setViewer(viewer);
      pdfState.viewer = viewer;

      eventBus.on('pagesinit', () => {
        viewer.currentScaleValue = 'page-width';
        pdfState.fitWidth = true;
        const item = pdfState.item;
        const savedPage = item && item.progress && !item.progress.completed ? item.progress.page : null;
        if (savedPage && savedPage <= viewer.pagesCount) viewer.currentPageNumber = savedPage;
        updatePdfLabels();
        pdfState.ready = true;
      });
      eventBus.on('pagechanging', () => {
        updatePdfLabels();
        if (pdfState.ready) savePdfPage(viewer.currentPageNumber);
      });
      eventBus.on('scalechanging', updatePdfLabels);
      // A last page taller than the screen only counts once scrolled to its bottom
      container.addEventListener('scroll', () => {
        if (pdfState.ready && container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
          savePdfPage(viewer.pagesCount);
        }
      }, { passive: true });
      // A PDF with nothing to scroll (e.g. a single slide) is read once the reader does something on it
      ['wheel', 'pointerdown'].forEach((type) => container.addEventListener(type, () => {
        if (pdfState.ready && container.scrollHeight - container.clientHeight <= 2) savePdfPage(viewer.pagesCount);
      }, { passive: true }));
      new ResizeObserver(() => {
        // Zero width while another viewer is showing
        if (pdfState.fitWidth && viewer.pagesCount && container.clientWidth > 0) viewer.currentScaleValue = 'page-width';
      }).observe(container);

      return { pdfjsLib, viewer, linkService, worker: new pdfjsLib.PDFWorker() };
    })();
    pdfViewerReady.catch(() => { pdfViewerReady = null; }); // Let the next PDF retry, e.g. after being offline
  }
  return pdfViewerReady;
}

async function loadPdfViewer(item) {
  const label = document.getElementById('pdf-page-label');
  label.textContent = 'Loading...';
  pdfState.item = item;
  pdfState.ready = false;

  let pdf;
  try {
    pdf = await getPdfViewer();
  } catch (err) {
    console.error('Error loading PDF.js:', err);
    if (pdfState.item === item) label.textContent = "Couldn't load the PDF viewer";
    return;
  }
  if (pdfState.item !== item) return; // Moved on while the viewer loaded

  if (pdfState.loadingTask) {
    // Take the previous PDF off screen before destroying it, so nothing renders from it while this one loads
    pdf.viewer.setDocument(null);
    pdf.linkService.setDocument(null);
    pdfState.loadingTask.destroy();
  }
  const loadingTask = pdf.pdfjsLib.getDocument({
    url: `/api/file?path=${encodeURIComponent(item.path)}`,
    worker: pdf.worker,
    isEvalSupported: false,
    cMapUrl: `${PDFJS_BASE}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
    wasmUrl: `${PDFJS_BASE}/wasm/`,
    iccUrl: `${PDFJS_BASE}/iccs/`
  });
  pdfState.loadingTask = loadingTask;
  try {
    const pdfDocument = await loadingTask.promise;
    if (pdfState.item !== item) return;
    pdf.viewer.setDocument(pdfDocument);
    pdf.linkService.setDocument(pdfDocument, null);
  } catch (err) {
    if (pdfState.item !== item || err.name === 'AbortException') return;
    console.error('Error opening PDF:', err);
    label.textContent = "Couldn't open this PDF";
  }
}

function savePdfPage(page) {
  const item = pdfState.item;
  const pages = pdfState.viewer.pagesCount;
  if (!item || state.currentItem !== item || !pages) return;
  const saved = item.progress || {};
  if (saved.page === page && saved.pages === pages) return;
  queueReadingPosition(item, { page, pages });
}

function updatePdfLabels() {
  const viewer = pdfState.viewer;
  if (!viewer || !viewer.pagesCount) return;
  document.getElementById('pdf-page-label').textContent = `Page ${viewer.currentPageNumber} of ${viewer.pagesCount}`;
  document.getElementById('pdf-zoom-label').textContent = pdfState.fitWidth ? 'Fit' : `${Math.round(viewer.currentScale * 100)}%`;
}

function changePdfPage(delta) {
  const viewer = pdfState.viewer;
  if (!viewer || !viewer.pagesCount) return;
  viewer.currentPageNumber = Math.min(viewer.pagesCount, Math.max(1, viewer.currentPageNumber + delta));
}

// -1/+1 zoom out/in; 0 fits the page width again
function zoomPdf(direction) {
  const viewer = pdfState.viewer;
  if (!viewer || !viewer.pagesCount) return;
  pdfState.fitWidth = direction === 0;
  if (direction === 0) {
    viewer.currentScaleValue = 'page-width';
  } else {
    viewer.currentScale = Math.min(4, Math.max(0.25, viewer.currentScale * (direction > 0 ? 1.15 : 1 / 1.15)));
  }
  updatePdfLabels();
}

// Toggle Complete via check box
async function toggleItemComplete(event, path) {
  event.preventDefault(); // The checkbox sits in the item's link: don't open the item
  event.stopPropagation();
  
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
    
    const res = await fetch(`/api/progress`, {
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

    const res = await fetch(`/api/progress`, {
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
    const res = await fetch(`/api/open-in-finder`, {
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
    const res = await fetch(`/api/open-in-system`, {
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

  const goalInput = document.getElementById('weekly-goal-input');
  if (goalInput && document.activeElement !== goalInput) {
    goalInput.value = state.activity.weeklyGoalHours || 5;
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
    const res = await fetch(`/api/ai-config`, {
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
    const res = await fetch(`/api/config`, {
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
    const res = await fetch(`/api/config/remove`, {
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
    const res = await fetch(`/api/progress/reset`, { method: 'POST' });
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
    const res = await fetch(`/api/courses/reset`, {
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
    const res = await fetch(`/api/courses/reset`, {
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
    const res = await fetch(`/api/courses/complete`, {
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
    const res = await fetch(`/api/courses/complete`, {
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

// --- RESIZABLE SIDE PANELS (COURSE CHAT & LESSON AI SIDEBAR) ---
// Dragging the handle on a panel's left edge sets its width, a CSS variable on the row holding it. The content
// beside the panel keeps besideMinWidth (also in the panel's max-width in style.css); dragging the panel over
// half of that expands it over the content, and dragging back undoes it. Sizes are saved under the panel's key.
const RESIZABLE_PANELS = {
  'course-chat': {
    rowId: 'course-summary-layout',
    panelId: 'course-chat-panel',
    widthVar: '--course-chat-width',
    minWidth: 320,
    besideMinWidth: 300, // Fits the course summary's buttons
    setExpanded: setCourseChatExpanded
  },
  'video-extra-sidebar': {
    rowId: 'workspace-main-content-row',
    panelId: 'video-extra-sidebar',
    widthVar: '--ai-sidebar-width',
    minWidth: 360, // Fits its tabs and buttons
    besideMinWidth: 360, // The lesson viewer
    setExpanded: setAiSidebarExpanded
  }
};

function initPanelSizes() {
  Object.entries(RESIZABLE_PANELS).forEach(([key, panel]) => {
    const width = parseInt(localStorage.getItem(`${key}-width`), 10);
    if (width) document.getElementById(panel.rowId).style.setProperty(panel.widthVar, `${width}px`);
  });
  // The lesson sidebar only covers the viewer while it's open; the course chat expands when opened (toggleCourseChat)
  setAiSidebarExpanded(localStorage.getItem('video-extra-sidebar-expanded') === 'true');
}

function startPanelResize(event, key) {
  if (event.button !== 0) return;
  event.preventDefault();

  const panel = RESIZABLE_PANELS[key];
  const handle = event.currentTarget;
  const row = document.getElementById(panel.rowId);
  const startX = event.clientX;
  const startWidth = document.getElementById(panel.panelId).getBoundingClientRect().width;
  const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
  const maxWidth = Math.max(panel.minWidth, row.clientWidth - gap - panel.besideMinWidth);
  let width = null;
  let expanded = null;

  // Capturing the pointer keeps the drag going over other elements, lesson frames and outside the window
  handle.setPointerCapture(event.pointerId);
  handle.classList.add('dragging');
  document.body.classList.add('resizing-panel');

  const onMove = (e) => {
    const wanted = startWidth + startX - e.clientX; // The handle is on the panel's left edge
    expanded = wanted > maxWidth + panel.besideMinWidth / 2;
    panel.setExpanded(expanded);
    if (!expanded) {
      width = Math.round(Math.min(Math.max(wanted, panel.minWidth), maxWidth));
      row.style.setProperty(panel.widthVar, `${width}px`);
    }
  };
  const onEnd = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('lostpointercapture', onEnd);
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing-panel');
    if (width !== null) localStorage.setItem(`${key}-width`, String(width));
    if (expanded !== null) localStorage.setItem(`${key}-expanded`, String(expanded));
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('lostpointercapture', onEnd);
}

// Double-clicking a panel's handle puts it back to its default size
function resetPanelSize(key) {
  const panel = RESIZABLE_PANELS[key];
  document.getElementById(panel.rowId).style.removeProperty(panel.widthVar);
  panel.setExpanded(false);
  localStorage.removeItem(`${key}-width`);
  localStorage.removeItem(`${key}-expanded`);
}

// --- VIDEO PLAYER EXTRA SIDEBAR LOGIC (TRANSCRIPT & AI SUMMARY) ---

function toggleExtraSidebar() {
  const sidebar = document.getElementById('video-extra-sidebar');
  if (!sidebar) return;
  
  sidebar.classList.toggle('collapsed');
  const collapsed = sidebar.classList.contains('collapsed');
  localStorage.setItem('video-extra-sidebar-collapsed', collapsed ? 'true' : 'false');
}

// Expanding the sidebar covers the lesson viewer while the sidebar is open (its width is dragged, see RESIZABLE_PANELS)
function setAiSidebarExpanded(expanded) {
  const sidebar = document.getElementById('video-extra-sidebar');
  if (sidebar.classList.contains('expanded') === expanded) return;
  sidebar.classList.toggle('expanded', expanded);

  const btn = document.getElementById('btn-expand-ai-sidebar');
  btn.classList.toggle('expanded', expanded);
  btn.title = expanded ? 'Restore Panel Size' : 'Expand Panel';
}

function toggleAiSidebarExpanded() {
  const expanded = !document.getElementById('video-extra-sidebar').classList.contains('expanded');
  setAiSidebarExpanded(expanded);
  localStorage.setItem('video-extra-sidebar-expanded', String(expanded));
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
  state.transcriptSegments = [];
  state.currentHasTranscript = false; // Until this item's metadata says otherwise
  updateRetranscribeButton(item, false);
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
  

  try {
    const res = await fetch(`/api/video/metadata?path=${encodeURIComponent(item.path)}`);
    if (!res.ok) throw new Error('Failed to load video metadata');
    
    const data = await res.json();
    // The user may have moved on while this loaded: don't show this item's notes (or auto-generate
    // notes, which targets the current item) under a different lesson
    if (!state.currentItem || state.currentItem.path !== item.path) return;
    state.currentHasTranscript = data.hasTranscript;
    updateRetranscribeButton(item, data.hasTranscript);
    if (data.hasTranscript && data.transcript.trim()) {
      renderTranscript(item, data.transcript);
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
      if (!isGenerating && canMakeAiNotes(item, data.hasTranscript)) {
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
    if (state.aiConfig && state.aiConfig.llmConfigured) {
      const flat = getEligibleItemsList();
      const index = flat.findIndex(i => i.path === item.path);
      if (index !== -1) {
        const nextFive = flat.slice(index + 1, index + 6);
        const prevFive = flat.slice(Math.max(0, index - 5), index);
        // Lectures that would need transcribing are left out when Modal isn't set up (whether they have a
        // transcript isn't known here)
        const neighborPaths = [...nextFive, ...prevFive].filter(i => canMakeAiNotes(i, false)).map(i => i.path);

        if (neighborPaths.length > 0) {
          console.log(`[Auto] Requesting background pre-generation for ${neighborPaths.length} neighbors...`);
          fetch(`/api/video/pregenerate-summaries`, {
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

// Lecture transcripts start each paragraph (or subtitle cue) with a [MM:SS] stamp
const TRANSCRIPT_STAMP = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;

function stampToSeconds(stamp) {
  return stamp.split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
}

// Show a lecture transcript with its stamps as buttons that seek the player; other text stays plain
function renderTranscript(item, text) {
  const body = document.getElementById('transcript-body');
  state.transcriptSegments = [];
  state.activeTranscriptIndex = -1;
  const stamps = isMediaItem(item) ? [...text.matchAll(TRANSCRIPT_STAMP)] : [];
  if (stamps.length === 0) {
    body.textContent = text;
    return;
  }

  body.textContent = '';
  const lead = text.slice(0, stamps[0].index).trim();
  if (lead) {
    const leadEl = document.createElement('div');
    leadEl.className = 'transcript-seg';
    leadEl.textContent = lead;
    body.appendChild(leadEl);
  }
  stamps.forEach((match, i) => {
    const start = stampToSeconds(match[1]);
    const end = i + 1 < stamps.length ? stamps[i + 1].index : text.length;
    const seg = document.createElement('div');
    seg.className = 'transcript-seg';
    const stampBtn = document.createElement('button');
    stampBtn.className = 'transcript-stamp';
    stampBtn.textContent = match[1];
    stampBtn.title = 'Play from here';
    stampBtn.addEventListener('click', () => seekCurrentMedia(start));
    const segText = document.createElement('span');
    segText.textContent = text.slice(match.index + match[0].length, end).trim();
    seg.append(stampBtn, segText);
    body.appendChild(seg);
    state.transcriptSegments.push({ start, el: seg });
  });
  const video = document.getElementById('main-video-player');
  if (state.videoItem === item) updateTranscriptHighlight(video.currentTime);
}

function seekCurrentMedia(seconds) {
  if (!isMediaItem(state.currentItem) || state.videoItem !== state.currentItem) return;
  const video = document.getElementById('main-video-player');
  video.currentTime = seconds;
  video.play().catch(err => console.log('Play failed:', err));
}

// Highlight the paragraph being spoken and keep it in view, unless the reader has just scrolled
function updateTranscriptHighlight(currentTime) {
  const segments = state.transcriptSegments;
  if (!segments || segments.length === 0 || state.videoItem !== state.currentItem) return;

  // Last paragraph that starts at or before the current time (they're in time order)
  let index = -1;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= currentTime + 0.25) {
      index = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (index === state.activeTranscriptIndex) return;
  if (segments[state.activeTranscriptIndex]) segments[state.activeTranscriptIndex].el.classList.remove('active');
  state.activeTranscriptIndex = index;
  if (index < 0) return;

  const el = segments[index].el;
  el.classList.add('active');
  if (Date.now() - (state.transcriptScrolledAt || 0) > 4000) {
    const pane = document.getElementById('transcript-body');
    const offset = el.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    pane.scrollTo({ top: pane.scrollTop + offset - pane.clientHeight / 3, behavior: 'smooth' });
  }
}

// Whether AI notes can be made for an item: Fireworks writes them, and only a lecture with neither a transcript nor
// subtitles has to be transcribed on Modal first
function canMakeAiNotes(item, hasTranscript) {
  const ai = state.aiConfig || {};
  const needsTranscription = isMediaItem(item) && !item.subtitlePath && !hasTranscript;
  return !!ai.llmConfigured && (!needsTranscription || !!ai.transcriptionConfigured);
}

// Lectures transcribed before captions existed only kept paragraph times: offer to transcribe them again
function updateRetranscribeButton(item, hasTranscript) {
  const btn = document.getElementById('btn-retranscribe');
  const ai = state.aiConfig || {};
  const generating = state.generatingTranscripts && state.generatingTranscripts[item.path];
  const offer = isMediaItem(item) && hasTranscript && !item.subtitlePath && ai.llmConfigured && ai.transcriptionConfigured && !generating;
  btn.style.display = offer ? '' : 'none';
}

// A transcription made captions: remember them on the lesson, and show them if it's in the player
function setItemCaptions(itemPath, subtitlePath) {
  state.courses.forEach(c => c.sections.forEach(s => s.items.forEach(i => {
    if (i.path === itemPath) i.subtitlePath = subtitlePath;
  })));
  const video = document.getElementById('main-video-player');
  if (state.videoItem && state.videoItem.path === itemPath && !video.querySelector('track')) {
    addCaptionsTrack(video, subtitlePath);
  }
}

async function generateTranscriptAndSummaryAction(options = {}) {
  if (!state.currentItem || !AI_NOTES_TYPES.includes(state.currentItem.type)) {
    showToast('No active video or document loaded.');
    return;
  }
  
  const genBtn = document.getElementById('btn-generate-transcript');
  const spinner = document.getElementById('ai-loading-spinner');
  const statusSpan = document.getElementById('ai-loading-status');
  
  if (!genBtn || !spinner) return;
  
  const isVideo = isMediaItem(state.currentItem);
  
  // Check settings configuration first (re-transcribing ignores the transcript a lecture has)
  if (!canMakeAiNotes(state.currentItem, state.currentHasTranscript && !options.retranscribe)) {
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
  document.getElementById('btn-retranscribe').style.display = 'none';
  spinner.style.display = 'flex';
  if (statusSpan) {
    statusSpan.textContent = isVideo
      ? 'Transcribing audio (takes a moment)...'
      : 'Extracting text and generating summary...';
  }
  
  try {
    const res = await fetch(`/api/video/generate-transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: targetPath, retranscribe: options.retranscribe === true })
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to generate transcription/summary');
    }
    
    const data = await res.json();
    showToast(`AI Notes generated successfully for ${targetItem.name}!`);
    if (data.subtitlePath) {
      setItemCaptions(targetPath, data.subtitlePath);
    }
    
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
      updateRetranscribeButton(state.currentItem, state.currentHasTranscript);
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
    const res = await fetch(`/api/course/summary-status?courseId=${encodeURIComponent(state.currentCourse.id)}`);
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
    const res = await fetch(`/api/course/generate-summary`, {
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
      const res = await fetch(`/api/course/summary-status?courseId=${encodeURIComponent(state.currentCourse.id)}`);
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
    const res = await fetch(`/api/video/chat`, {
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
  const layout = document.getElementById('course-summary-layout');
  if (!layout) return;

  if (layout.classList.toggle('chat-open')) {
    setCourseChatExpanded(localStorage.getItem('course-chat-expanded') === 'true'); // Opens the size it was left at
    // Scroll messages to bottom when opening
    const messagesBody = document.getElementById('course-chat-messages-body');
    if (messagesBody) messagesBody.scrollTop = messagesBody.scrollHeight;
  } else {
    setCourseChatExpanded(false); // Brings the summary back
  }
}

// Expanding the chat hides the summary so the chat fills the row (its width is dragged, see RESIZABLE_PANELS)
function setCourseChatExpanded(expanded) {
  const layout = document.getElementById('course-summary-layout');
  if (layout.classList.contains('chat-expanded') === expanded) return;

  // Hiding the summary resets its scroll position, so it's put back when the summary shows again
  const summary = layout.querySelector('.course-summary-panel');
  if (expanded) layout.dataset.summaryScroll = summary.scrollTop;
  layout.classList.toggle('chat-expanded', expanded);
  if (!expanded) summary.scrollTop = Number(layout.dataset.summaryScroll) || 0;

  const btn = document.getElementById('btn-expand-course-chat');
  btn.classList.toggle('expanded', expanded);
  btn.title = expanded ? 'Restore Chat Size' : 'Expand Chat';
}

function toggleCourseChatExpanded() {
  const expanded = !document.getElementById('course-summary-layout').classList.contains('chat-expanded');
  setCourseChatExpanded(expanded);
  localStorage.setItem('course-chat-expanded', String(expanded));
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
    const res = await fetch(`/api/course/chat`, {
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
window.toggleCourseChatExpanded = toggleCourseChatExpanded;
window.sendCourseQuickQuestion = sendCourseQuickQuestion;
window.handleCourseChatInputKeyDown = handleCourseChatInputKeyDown;
window.sendCourseChatMessage = sendCourseChatMessage;
window.renderCourseChatMessages = renderCourseChatMessages;

