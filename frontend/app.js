// Browser polyfill
if (typeof window !== 'undefined' && !window.process) {
  window.process = { env: { NODE_ENV: 'development' } };
}

// ════════════════════════════════════════
// CONFIG — points to your backend
// ════════════════════════════════════════
const STATE_STORAGE_KEY = 'thinkia_state';
const DEVICE_ID_KEY = 'thinkia_device_id';
const DASHBOARD_REFRESH_INTERVAL_MS = 10000;

function getApiBase() {
  if (typeof window === 'undefined') return '';
  const host = window.location.hostname;
  return (host === 'localhost' || host === '127.0.0.1') ? 'http://localhost:3001' : '';
}

function buildApiUrl(endpoint) {
  const base = getApiBase();
  const path = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
  return base + path;
}

// Device ID management for guest access
function getOrCreateDeviceId() {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = 'device_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

function getDeviceId() {
  return localStorage.getItem(DEVICE_ID_KEY);
}

// ════════════════════════════════════════
// STATE
// ════════════════════════════════════════
let currentUser = null;
let authToken = null;
let profile = { name: 'Guest', joinedDate: new Date().toISOString().split('T')[0] };
let metrics = { depth: 0, assumptions: 0, counterargument: 0, evidence: 0, clarity: 0 };
let bloomCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
let allFallacies = new Set();
let frameworks = new Map();
let allConcepts = new Set();
let allResources = [];
let conversationHistory = [];
let msgCount = 0;
let quizHistory = [];
let sessionStart = Date.now();
let sessionActivity = [];
let quizData = null;
let quizState = {};
let notifications = [];
let currentSessionId = null;
let currentGoal = null;
let chatSessions = [];
let currentChatIndex = -1;
let goals = [];
let sessionCache = {};
let usageStats = { totalMessages: 0, totalSessions: 0 };
let dashboardRefreshTimer = null;
let dashboardRefreshPromise = null;

// FIX 1: Declare sessionTimerInterval so it doesn't become an implicit global
let sessionTimerInterval = null;

// FIX 4: Guard to prevent rapid session switching causing mixed messages
let isLoadingSession = false;

function getEmptyMetrics() {
  return { depth: 0, assumptions: 0, counterargument: 0, evidence: 0, clarity: 0 };
}

function isChatPage() {
  return Boolean(document.getElementById('chatList'));
}

function isDashboardPage() {
  return Boolean(document.getElementById('radarCanvas'));
}

// Apply saved theme on any page
if (typeof localStorage !== 'undefined' && localStorage.getItem('thinkia-theme') === 'dark') {
  document.documentElement.setAttribute('data-theme', 'dark');
}

// ════════════════════════════════════════
// PERSIST STATE (localStorage)
// ════════════════════════════════════════
function readSavedState() {
  if (typeof localStorage === 'undefined') return null;
  const saved = localStorage.getItem(STATE_STORAGE_KEY);
  if (!saved) return null;

  try {
    return JSON.parse(saved);
  } catch (e) {
    console.warn('Failed to load saved state:', e);
    return null;
  }
}

function saveState() {
  if (typeof localStorage === 'undefined') return;
  const state = {
    profile,
    metrics,
    bloomCounts,
    allFallacies: Array.from(allFallacies),
    frameworks: Array.from(frameworks.entries()),
    allConcepts: Array.from(allConcepts),
    allResources,
    msgCount,
    quizHistory,
    sessionActivity,
    chatSessions,
    currentChatIndex,
    currentSessionId,
    currentGoal,
    sessionCache,
    usageStats
  };
  localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  const state = readSavedState();
  if (!state) return;

  if (state.profile) profile = state.profile;
  if (state.metrics) metrics = state.metrics;
  if (state.bloomCounts) bloomCounts = state.bloomCounts;
  if (Array.isArray(state.allFallacies)) allFallacies = new Set(state.allFallacies);
  if (Array.isArray(state.frameworks)) frameworks = new Map(state.frameworks);
  if (Array.isArray(state.allConcepts)) allConcepts = new Set(state.allConcepts);
  if (Array.isArray(state.allResources)) allResources = state.allResources;
  if (typeof state.msgCount === 'number') msgCount = state.msgCount;
  if (Array.isArray(state.quizHistory)) quizHistory = state.quizHistory;
  if (Array.isArray(state.sessionActivity)) sessionActivity = state.sessionActivity;
  if (Array.isArray(state.chatSessions)) chatSessions = state.chatSessions;
  if (state.currentChatIndex !== undefined) currentChatIndex = state.currentChatIndex;
  if (Object.prototype.hasOwnProperty.call(state, 'currentSessionId')) currentSessionId = state.currentSessionId;
  if (Object.prototype.hasOwnProperty.call(state, 'currentGoal')) currentGoal = state.currentGoal;
  if (state.sessionCache && typeof state.sessionCache === 'object') sessionCache = state.sessionCache;
  if (state.usageStats) usageStats = state.usageStats;
}

function loadDashboardLocalState() {
  const state = readSavedState();
  if (!state) return;

  if (state.profile) profile = state.profile;
  if (Array.isArray(state.quizHistory)) quizHistory = state.quizHistory;
  if (Array.isArray(state.sessionActivity)) sessionActivity = state.sessionActivity;
}

function syncCurrentSessionCache() {
  if (!currentSessionId) return;

  sessionCache[currentSessionId] = {
    messages: conversationHistory.map(msg => ({
      role: msg.role,
      content: msg.content,
      bloom_level: msg.bloom_level || null,
      bloom_label: msg.bloom_label || '',
      thinking_insight: msg.thinking_insight || '',
      challenge_question: msg.challenge_question || '',
      metrics: msg.metrics || null,
      fallacies_detected: msg.fallacies_detected || [],
      framework_suggested: msg.framework_suggested || null,
      concepts: msg.concepts || [],
      resources: msg.resources || [],
      raw_content: msg.raw_content || null
    })),
    goal: currentGoal || '',
    updated_at: new Date().toISOString()
  };

  const sessionIdx = chatSessions.findIndex(s => s.id === currentSessionId);
  if (sessionIdx >= 0) {
    chatSessions[sessionIdx] = {
      ...chatSessions[sessionIdx],
      updated_at: sessionCache[currentSessionId].updated_at
    };
    currentChatIndex = sessionIdx;
  }
}

if (typeof document !== 'undefined') {
  if (isDashboardPage()) {
    loadDashboardLocalState();
  } else {
    loadState();
  }
}

const METRIC_LABELS = {
  depth: 'Depth of Inquiry',
  assumptions: 'Assumption Awareness',
  counterargument: 'Counterargument Openness',
  evidence: 'Evidence Seeking',
  clarity: 'Conceptual Clarity'
};
const BLOOM_NAMES = { 1: 'Remember', 2: 'Understand', 3: 'Apply', 4: 'Analyse', 5: 'Evaluate', 6: 'Create' };
const BLOOM_COLORS = { 1: '#e8c840', 2: '#e88c20', 3: '#c8441a', 4: '#8a2be2', 5: '#1a6b4a', 6: '#1a4e7a' };
const QUIZ_TYPE_META = {
  mid:     { label: 'Quick Recall',   color: '#c8441a', n: 5  },
  weekly:  { label: 'Weekly Review',  color: '#1a4e7a', n: 10 },
  monthly: { label: 'Monthly Deep',   color: '#1a6b4a', n: 15 }
};

const FALLBACK_STARTERS = [
  "What makes an argument logically sound versus emotionally persuasive?",
  "How do cognitive biases affect our decision-making?",
  "Should we prioritize collective good over individual freedom?",
  "What role does evidence play in forming beliefs?",
  "How can we think more critically about information we consume daily?"
];

async function fetchStarterQuestions() {
  try {
    const data = await apiGet('/api/starter-questions');
    if (data?.questions && Array.isArray(data.questions)) {
      return data.questions;
    }
    return FALLBACK_STARTERS;
  } catch (err) {
    console.warn('Failed to fetch starter questions:', err);
    return FALLBACK_STARTERS;
  }
}

// ════════════════════════════════════════
// API HELPERS — call your backend
// ════════════════════════════════════════
async function callAPI(messages, system, max_tokens = 1200) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const res = await fetch(buildApiUrl('/api/chat'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ messages, system, max_tokens, session_id: currentSessionId })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Backend error: ${res.status}`);
  return data;
}

async function apiGet(endpoint) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  try {
    const res = await fetch(buildApiUrl(endpoint), { headers });
    if (!res.ok) {
      const data = await res.json();
      addSystemNotification('error', 'API Error', data.error || `Request failed: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    addSystemNotification('error', 'Connection Error', 'Cannot reach ThinkIA backend. Make sure the server is running.');
    return null;
  }
}

async function apiPost(endpoint, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  try {
    const res = await fetch(buildApiUrl(endpoint), {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const data = await res.json();
      addSystemNotification('error', 'API Error', data.error || `Request failed: ${res.status}`);
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (err.message?.includes('Request failed') || err.message?.includes('API Error')) {
      throw err;
    }
    addSystemNotification('error', 'Connection Error', 'Cannot reach ThinkIA backend. Make sure the server is running.');
    throw err;
  }
}

// ════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════
function addSystemNotification(type, title, message) {
  notifications.unshift({ type, title, message, time: new Date() });
  const list = document.getElementById('notifList');
  if (list) {
    const existingEmpty = list.querySelector('.empty-note');
    if (existingEmpty) existingEmpty.remove();

    const notif = document.createElement('div');
    notif.className = `system-notif ${type}`;
    notif.innerHTML = `
      <div class="sn-header">
        <span class="sn-type">${type === 'error' ? '⚠️' : type === 'warn' ? '⚡' : 'ℹ️'}</span>
        <span class="sn-title">${escHtml(title)}</span>
        <span class="sn-time">${new Date().toLocaleTimeString()}</span>
      </div>
      <div class="sn-message">${escHtml(message)}</div>
    `;
    list.prepend(notif);

    const badge = document.getElementById('notifBadge');
    if (badge) {
      badge.style.display = 'inline';
      const count = notifications.length;
      badge.textContent = count > 9 ? '9+' : count;
    }
  }
}

function showNotifications() {
  const panel = document.getElementById('notificationsPanel');
  const backdrop = document.getElementById('notifBackdrop');
  if (panel && backdrop) {
    const isVisible = panel.classList.contains('show');
    panel.classList.toggle('show', !isVisible);
    backdrop.classList.toggle('show', !isVisible);
  }
}

// ════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════
const SETTINGS_KEY = 'thinkia_settings';

const defaultSettings = {
  quizFrequency: 6,
  notifFrequency: 20,
  personalizedNotif: true
};

function loadSettings() {
  const saved = localStorage.getItem(SETTINGS_KEY);
  if (saved) {
    try { return { ...defaultSettings, ...JSON.parse(saved) }; }
    catch { return { ...defaultSettings }; }
  }
  return { ...defaultSettings };
}

function saveSettings() {
  const settings = {
    quizFrequency: parseInt(document.getElementById('quizFrequency')?.value || 6),
    notifFrequency: parseInt(document.getElementById('notifFrequency')?.value || 20),
    personalizedNotif: document.getElementById('personalizedNotif')?.checked ?? true
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  applySettings(settings);
}

function applySettings(settings) {
  // Apply quiz frequency
  window.QUIZ_FREQUENCY = settings.quizFrequency;
  
  // Reconfigure notification timers
  if (window.notificationTimers) {
    window.notificationTimers.forEach(t => clearTimeout(t));
    startNotificationTimers();
  }
}

function showSettings() {
  const settings = loadSettings();
  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  
  if (document.getElementById('quizFrequency')) {
    document.getElementById('quizFrequency').value = settings.quizFrequency;
  }
  if (document.getElementById('notifFrequency')) {
    document.getElementById('notifFrequency').value = settings.notifFrequency;
  }
  if (document.getElementById('personalizedNotif')) {
    document.getElementById('personalizedNotif').checked = settings.personalizedNotif;
  }
  
  // Show account section if logged in (not guest)
  const user = JSON.parse(localStorage.getItem('thinkia_user') || '{}');
  const accountSection = document.getElementById('accountSection');
  if (accountSection && !user.is_guest) {
    accountSection.style.display = 'block';
    if (document.getElementById('displayName')) {
      document.getElementById('displayName').value = user.name || '';
    }
  }
  
  modal.style.display = 'flex';
}

function closeSettings() {
  const modal = document.getElementById('settingsModal');
  if (modal) modal.style.display = 'none';
}

function updateAccount() {
  const name = document.getElementById('displayName')?.value.trim();
  if (!name) return;
  const user = JSON.parse(localStorage.getItem('thinkia_user') || '{}');
  user.name = name;
  localStorage.setItem('thinkia_user', JSON.stringify(user));
  profile.name = name;
  if (document.getElementById('uiName')) document.getElementById('uiName').textContent = name;
  if (document.getElementById('uiAvatar')) document.getElementById('uiAvatar').textContent = name[0].toUpperCase();
  if (document.getElementById('headerAv')) document.getElementById('headerAv').textContent = name[0].toUpperCase();
  if (document.getElementById('dashAv')) document.getElementById('dashAv').textContent = name[0].toUpperCase();
  if (document.getElementById('dashName')) document.getElementById('dashName').textContent = name;
  if (document.getElementById('uiAv')) document.getElementById('uiAv').textContent = name[0].toUpperCase();
  alert('Profile updated!');
}

// Initialize settings on load
function initSettings() {
  const settings = loadSettings();
  window.QUIZ_FREQUENCY = settings.quizFrequency;
  window.NOTIF_FREQUENCY = settings.notifFrequency;
  window.PERSONALIZED_NOTIF = settings.personalizedNotif;
}

initSettings();

// ════════════════════════════════════════
// GOAL MODAL
// ════════════════════════════════════════
function promptGoalAndStartChat() {
  const modal = document.getElementById('goalModal');
  if (modal) {
    modal.style.display = 'flex';
    const input = document.getElementById('goalInput');
    if (input) {
      input.value = '';
      input.focus();
    }
  }
}

function setGoalSuggestion(text) {
  const input = document.getElementById('goalInput');
  if (input) {
    input.value = text;
  }
}

async function startWithGoal() {
  const goalInput = document.getElementById('goalInput');
  const goal = goalInput ? goalInput.value.trim() : '';

  currentGoal = goal;

  const modal = document.getElementById('goalModal');
  if (modal) modal.style.display = 'none';

  await createNewChatWithGoal(goal);
}

function skipGoal() {
  currentGoal = null;
  const modal = document.getElementById('goalModal');
  if (modal) modal.style.display = 'none';
  createNewChatWithoutGoal();
}

async function createNewChatWithGoal(goal) {
  // 🔧 FIX: Verify token is still valid before creating session
  if (authToken) {
    try {
      const res = await fetch(buildApiUrl('/health'));
      if (!res.ok) throw new Error('Backend unreachable');
    } catch (e) {
      console.warn('Backend check failed:', e);
      addSystemNotification('error', 'Connection Error', 'Cannot reach backend. Please check if server is running.');
      return;
    }
  }

  try {
    const res = await apiPost('/api/sessions', { title: 'New Chat' });

    if (res && res.id) {
      currentSessionId = res.id;
      currentGoal = goal;

      if (goal) {
        await apiPost('/api/goals', { goal, session_id: currentSessionId });

        const goalIndicator = document.getElementById('goalIndicator');
        const goalText = document.getElementById('goalText');
        if (goalIndicator) goalIndicator.style.display = 'flex';
        if (goalText) goalText.textContent = goal.length > 30 ? goal.substring(0, 30) + '...' : goal;
      }

      chatSessions.unshift({
        id: res.id,
        title: res.title || 'New Chat',
        goal: goal,
        created_at: res.created_at || new Date().toISOString(),
        messages: []
      });
      usageStats.totalSessions = chatSessions.length;
      currentChatIndex = 0;
      conversationHistory = [];
      msgCount = 0;
      resetSessionSidebarState();

      showWelcome();
      renderChatList();
      loadAllGoals();
      syncCurrentSessionCache();
      saveState();

    } else {
      console.error('Session creation failed:', res);
      showToast('warn', 'Error', 'Could not create new chat session.', 4000);
    }
  } catch (err) {
    console.warn('Failed to create session:', err);
    showToast('warn', 'Error', 'Could not create new chat session.', 4000);
  }
}

function createNewChatWithoutGoal() {
  createNewChatWithGoal('');
}

function showWelcome() {
  const messagesEl = document.getElementById('messages');
  if (messagesEl) {
    messagesEl.innerHTML = '';
    const welcome = document.createElement('div');
    welcome.className = 'welcome';
    welcome.id = 'welcome';
    welcome.innerHTML = `
      <div class="welcome-icon">🧠</div>
      <h2>Ask anything. Build your <em>mind</em> doing it.</h2>
      <p>ThinkIA answers your questions using Bloom's Taxonomy — guiding you from recall to creation.</p>
      <div class="starters" id="starters"></div>
    `;
    messagesEl.appendChild(welcome);
    initRandomStarters();
  }
}

async function loadAllGoals() {
  try {
    const goalsData = await apiGet('/api/goals');
    goals = Array.isArray(goalsData) ? goalsData : [];
    renderGoalsList();
  } catch (err) {
    console.warn('Failed to load goals:', err);
    goals = [];
  }
}

function renderGoalsList() {
  const list = document.getElementById('goalsList');
  if (!list) return;

  if (goals.length === 0) {
    list.innerHTML = '<p class="empty-note" style="font-size:0.76rem">No goals yet. Start a new chat to set your first goal!</p>';
    return;
  }

  // FIX 8: Escape goal text to prevent XSS / layout breaks
  list.innerHTML = goals.map(g => {
    const date = new Date(g.created_at).toLocaleDateString();
    return `
      <div class="goal-item" onclick="openChatFromGoal('${g.session_id}')">
        <div class="goal-item-icon">🎯</div>
        <div class="goal-item-content">
          <div class="goal-item-text">${escHtml(g.goal || '(No specific goal)')}</div>
          <div class="goal-item-date">${date}</div>
        </div>
      </div>
    `;
  }).join('');
}

function openChatFromGoal(sessionId) {
  window.location.href = 'index.html?session=' + sessionId;
}

function startNewChatFromDashboard() {
  window.location.href = 'index.html';
}

// ════════════════════════════════════════
// SIDEBAR TABS
// ════════════════════════════════════════
function switchSidebarTab(name, btn) {
  document.querySelectorAll('.cs-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.cs-tab-content').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const tabContent = document.getElementById('tab-' + name);
  if (tabContent) tabContent.classList.add('active');
}

// ════════════════════════════════════════
// SYSTEM PROMPTS
// ════════════════════════════════════════
function getSystemPrompt(goal = null) {
  const goalContext = goal ? `\n\nIMPORTANT USER GOAL: The user has set the following goal for this session: "${goal}"\n\nThroughout this conversation, keep this goal in mind and:\n1. Guide responses to help the user achieve their goal\n2. Ask clarifying questions related to the goal when needed\n3. Provide examples and insights that directly support the goal\n4. Periodically check if your responses are helping achieve the goal\n\n` : '';

  return `You are ThinkIA, an AI critical thinking coach and Intelligence Amplifier. Answer questions helpfully while coaching reasoning using Bloom's Taxonomy.${goalContext}
ALWAYS return valid JSON only (no backticks, no preamble):
{
  "answer": "Full helpful answer, 2-4 paragraphs. Use \\n\\n for paragraph breaks.",
  "bloom_level": 1,
  "bloom_label": "Remember|Understand|Apply|Analyse|Evaluate|Create",
  "thinking_insight": "Specific observation about HOW the user is thinking or framing the question.",
  "challenge_question": "One Socratic question pushing one level higher on Bloom's.",
  "metrics": { "depth": 0, "assumptions": 0, "counterargument": 0, "evidence": 0, "clarity": 0 },
  "fallacies_detected": [],
  "framework_suggested": { "name": "...", "description": "..." },
  "concepts": ["key concept 1", "key concept 2", "key concept 3"],
  "resources": [
    {"type":"book","title":"Book Title","author":"Author Name"},
    {"type":"video","title":"Video Title","channel":"Channel Name"},
    {"type":"article","title":"Article Title","source":"Publication"}
  ]
}

Bloom's levels: 1=Remember, 2=Understand, 3=Apply, 4=Analyse, 5=Evaluate, 6=Create.
Assign bloom_level based on what cognitive level the USER's question operates at.
metrics: each value 0-20 based on how well the user demonstrated that skill.
resources: 1-3 real, verified books/videos/articles only.
concepts: 3-5 key concepts you drew on to answer.`;
}

const SYSTEM_PROMPT = getSystemPrompt();

const QUIZ_SYSTEM = `Generate a multiple-choice quiz based on this conversation.
Return ONLY valid JSON (no backticks, no markdown):
{
  "topic": "2-4 word topic",
  "questions": [
    { "q": "Question text", "options": ["A","B","C","D"], "correct": 0, "explanation": "Why correct and why others are wrong." }
  ]
}
Mix recall (Bloom 1-2) and higher-order (Bloom 3-6) questions. All questions must be answerable from the conversation.`;

// ════════════════════════════════════════
// PROFILE — Auto login as Guest
// ════════════════════════════════════════
function initGuestProfile() {
  const today = new Date().toISOString().split('T')[0];
  if (!sessionActivity.includes(today)) {
    sessionActivity.push(today);
  }
  const headerAvatar = document.getElementById('headerAv');
  if (headerAvatar) {
    headerAvatar.textContent = profile.name[0].toUpperCase();
  }
  if (!window.sessionTimerInterval) {
    startNotificationTimers();
    startSessionTimer();
  }
  saveState();
}

function handleSend() {
  sendMessage();
}

function handleLogout() {
  localStorage.removeItem('thinkia_user');
  localStorage.removeItem('thinkia_token');
  localStorage.removeItem(STATE_STORAGE_KEY);
  window.location.href = 'login.html';
}

// ════════════════════════════════════════
// SESSION NOTIFICATIONS
// ════════════════════════════════════════
function startNotificationTimers() {
  window.notificationTimers = [];
  if (!window.PERSONALIZED_NOTIF) return;
  
  const notifFreq = window.NOTIF_FREQUENCY || 20;
  if (notifFreq <= 0) return;
  
  // Milestone notifications based on frequency setting
  window.notificationTimers.push(setTimeout(() => addSessionNotification('info', '🧠 ' + notifFreq + ' min milestone', 'You\'re on a roll! Keep exploring — depth comes from sustained inquiry.'), notifFreq * 60 * 1000));
  window.notificationTimers.push(setTimeout(() => addSessionNotification('warn', '⏱ Time for a break!', 'You\'ve been thinking for ' + (notifFreq * 2) + ' minutes. Step away and let ideas settle.'), notifFreq * 2 * 60 * 1000));
  window.notificationTimers.push(setTimeout(() => addSessionNotification('warn', '⏱ Extended session', (notifFreq * 3) + ' minutes active. Consider switching to offline reflection.'), notifFreq * 3 * 60 * 1000));
}

function addSessionNotification(type, title, msg) {
  const container = document.getElementById('sessionNotifications');
  if (!container) return;

  const notif = document.createElement('div');
  notif.className = `session-notif ${type}`;
  notif.innerHTML = `<div class="sn-title">${escHtml(title)}</div><div class="sn-msg">${escHtml(msg)}</div>`;
  container.appendChild(notif);

  setTimeout(() => {
    notif.classList.add('dismiss');
    setTimeout(() => notif.remove(), 300);
  }, 15000);
}

// FIX 7: Only show this toast if the user is on the chat page
setTimeout(() => {
  if (typeof document !== 'undefined' && isChatPage()) {
    showToast('success', '💡 Tip: Active Recall', 'A quiz will appear every 6 messages to lock in what you\'ve learned. Try to answer from memory!', 6000);
  }
}, 2 * 60 * 1000);

function showToast(type, title, msg, duration = 5000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${type === 'warn' ? '⏱' : type === 'success' ? '✅' : 'ℹ️'}</div>
    <div class="toast-body"><div class="toast-title">${escHtml(title)}</div><div class="toast-msg">${escHtml(msg)}</div></div>
    <button class="toast-close" onclick="dismissToast(this.parentElement)">✕</button>`;
  container.appendChild(toast);
  setTimeout(() => dismissToast(toast), duration);
}

function dismissToast(t) {
  if (!t || !t.parentElement) return;
  t.classList.add('dismiss');
  setTimeout(() => t.remove(), 300);
}

// ════════════════════════════════════════
// SESSION TIMER
// ════════════════════════════════════════
function startSessionTimer() {
  updateSessionTimer();
  // FIX 1: sessionTimerInterval is now declared at the top
  sessionTimerInterval = setInterval(updateSessionTimer, 1000);
}

function updateSessionTimer() {
  const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;

  const timerEl = document.getElementById('stTime');
  if (timerEl) timerEl.textContent = timeStr;

  const dsTimeEl = document.getElementById('dsTime');
  if (dsTimeEl) dsTimeEl.textContent = mins < 1 ? '<1m' : `${mins}m`;
}

// ════════════════════════════════════════
// SOURCES (Left Sidebar)
// ════════════════════════════════════════
function updateSources(data) {
  renderSessionSources();
  saveState();
}

async function searchYouTube(title, channel) {
  const query = channel ? `${title} ${channel}`.trim() : title;
  
  try {
    // Try API first for exact links
    const res = await fetch(buildApiUrl(`/api/youtube/search?${encodeURIComponent(query)}`), {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const data = await res.json();
    
    if (data.videos && data.videos.length > 0) {
      // Open first exact video
      window.open(data.videos[0].url, '_blank');
      return;
    }
    
    // Fallback to search
    if (data.searchUrl) {
      window.open(data.searchUrl, '_blank');
    }
  } catch (e) {
    // Fallback to regular search
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    window.open(url, '_blank');
  }
}

function searchBook(title, author) {
  const query = title + (author ? ' ' + author : '');
  const url = `https://www.google.com/search?q=${encodeURIComponent(query + ' book')}`;
  window.open(url, '_blank');
}

function searchArticle(title, source) {
  const query = title + (source ? ' ' + source : '');
  const url = `https://www.google.com/search?q=${encodeURIComponent(query + ' article')}`;
  window.open(url, '_blank');
}

// ════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════
function switchTab(name, btn) {
  loadDashboardLocalState();
  document.querySelectorAll('.dash-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.dash-tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');

  if (name === 'overview') {
    refreshDashboard();
    drawRadar();
    drawBloomChart();
  } else if (name === 'bloom') {
    drawBloomChart();
  } else if (name === 'resources') {
    updateDashboardResources();
  } else if (name === 'quizzes') {
    updateQuizHistory();
  } else {
    refreshDashboard();
  }
}

function updateQuizHistory() {
  const qh = document.getElementById('dashQuizHist');
  if (qh) {
    if (quizHistory.length === 0) {
      qh.innerHTML = '<p class="empty-note" style="font-size:0.76rem">No quizzes taken yet. Take a quiz during your chat sessions!</p>';
    } else {
      qh.innerHTML = quizHistory.map(q => `
        <div class="quiz-hist-item">
          <span>
            <span class="qhi-badge" style="background:${QUIZ_TYPE_META[q.type]?.color || '#666'}22;color:${QUIZ_TYPE_META[q.type]?.color || '#666'}">${QUIZ_TYPE_META[q.type]?.label || 'Quiz'}</span>
            ${escHtml(q.topic)}
          </span>
          <span style="font-weight:600;color:var(--accent)">${q.score}%</span>
        </div>
      `).join('');
    }
  }
}

function renderChatSessions() {
  const list = document.getElementById('chatSessionsList');
  if (!list) return;

  if (chatSessions.length === 0) {
    list.innerHTML = '<p class="empty-note" style="font-size:0.76rem">No conversations yet. Start chatting!</p>';
    return;
  }

  // FIX 8: Escape session title to prevent XSS / layout breaks
  list.innerHTML = chatSessions.map(session => {
    const date = new Date(session.created_at).toLocaleDateString();
    return `
      <div class="dash-chat-item" onclick="openChatFromDashboard('${session.id}')">
        <div class="dci-icon">💬</div>
        <div class="dci-content">
          <div class="dci-title">${escHtml(session.title || 'New Chat')}</div>
          <div class="dci-date">${date}</div>
        </div>
      </div>
    `;
  }).join('');
}

function openChatFromDashboard(sessionId) {
  window.location.href = 'index.html?session=' + sessionId;
}

function refreshDashboard() {
  updateDashboard();
  updateDashboardResources();
  renderGoalsList();
  renderChatSessions();
}

async function refreshDashboardRealtimeData() {
  if (!isDashboardPage()) return;
  if (dashboardRefreshPromise) return dashboardRefreshPromise;

  loadDashboardLocalState();
  refreshDashboard();

  dashboardRefreshPromise = Promise.all([
    loadAllSessions({ persist: false }),
    loadUserMetrics({ persist: false }),
    loadUserResources({ persist: false }),
    loadUserConcepts({ persist: false }),
    loadAllGoals()
  ]).then(() => {
    loadDashboardLocalState();
    refreshDashboard();
  }).catch(err => {
    console.warn('Failed to refresh dashboard data:', err);
  }).finally(() => {
    dashboardRefreshPromise = null;
  });

  return dashboardRefreshPromise;
}

function scheduleDashboardRealtimeRefresh(delay = 250) {
  if (!isDashboardPage()) return;

  if (dashboardRefreshTimer) {
    clearTimeout(dashboardRefreshTimer);
  }

  dashboardRefreshTimer = setTimeout(() => {
    dashboardRefreshTimer = null;
    refreshDashboardRealtimeData();
  }, delay);
}

function startDashboardRealtimeSync() {
  if (!isDashboardPage() || window.thinkiaDashboardRealtimeStarted) return;

  window.thinkiaDashboardRealtimeStarted = true;

  window.addEventListener('storage', event => {
    if (event.key === 'thinkia_user' || event.key === 'thinkia_token') {
      if (!localStorage.getItem('thinkia_user') || !localStorage.getItem('thinkia_token')) {
        window.location.href = 'login.html';
      }
      return;
    }

    if (event.key === STATE_STORAGE_KEY) {
      loadDashboardLocalState();
      refreshDashboard();
      scheduleDashboardRealtimeRefresh();
    }
  });

  window.addEventListener('focus', () => scheduleDashboardRealtimeRefresh(0));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      scheduleDashboardRealtimeRefresh(0);
    }
  });

  window.setInterval(() => {
    if (!document.hidden) {
      refreshDashboardRealtimeData();
    }
  }, DASHBOARD_REFRESH_INTERVAL_MS);
}

function updateDashboardResources() {
  const qh = document.getElementById('dashQuizHist');
  if (qh) {
    qh.innerHTML = quizHistory.length === 0
      ? '<p class="empty-note" style="font-size:0.76rem">No quizzes taken yet.</p>'
      : quizHistory.map(q => `<div class="quiz-hist-item"><span><span class="qhi-badge" style="background:${QUIZ_TYPE_META[q.type]?.color || '#666'}22;color:${QUIZ_TYPE_META[q.type]?.color || '#666'}">${QUIZ_TYPE_META[q.type]?.label || 'Quiz'}</span>${escHtml(q.topic)}</span><span style="font-weight:600;color:var(--accent)">${q.score}%</span></div>`).join('');
  }
  const makeCard = r => {
    let content = `<div class="rc-title">${escHtml(r.title)}</div><div class="rc-sub">${escHtml(r.author || r.channel || r.source || '')}</div>`;
    if (r.type === 'video' && r.url) {
      return `<a href="${r.url}" target="_blank" rel="noopener noreferrer" class="resource-card resource-link"><div class="rc-type video">▶️ Video</div>${content}</a>`;
    } else if (r.type === 'video') {
      return `<div class="resource-card" onclick="searchYouTube('${encodeURIComponent(r.title)}', '${encodeURIComponent(r.channel || '')}')" style="cursor:pointer;"><div class="rc-type video">▶️ Video</div>${content}</div>`;
    }
    return `<div class="resource-card"><div class="rc-type ${r.type}">${r.type === 'book' ? '📚 Book' : r.type === 'article' ? '📄 Article' : '▶️ Video'}</div>${content}</div>`;
  };
  const books = allResources.filter(r => r.type === 'book');
  const videos = allResources.filter(r => r.type === 'video');
  const articles = allResources.filter(r => r.type === 'article');
  const dashBooks = document.getElementById('dashBooks');
  if (dashBooks) dashBooks.innerHTML = books.length ? books.map(makeCard).join('') : '<p class="empty-note" style="font-size:0.76rem">No books recommended yet.</p>';
  const dashVideos = document.getElementById('dashVideos');
  if (dashVideos) dashVideos.innerHTML = videos.length ? videos.map(makeCard).join('') : '<p class="empty-note" style="font-size:0.76rem">No videos recommended yet.</p>';
  const dashArticles = document.getElementById('dashArticles');
  if (dashArticles) dashArticles.innerHTML = articles.length ? articles.map(makeCard).join('') : '<p class="empty-note" style="font-size:0.76rem">No articles recommended yet.</p>';
  const dc = document.getElementById('dashConceptChips');
  if (dc) {
    dc.innerHTML = '';
    if (allConcepts.size === 0) {
      dc.innerHTML = '<p class="empty-note" style="font-size:0.76rem">Concepts will appear as you chat.</p>';
    } else {
      allConcepts.forEach(c => {
        const chip = document.createElement('span');
        chip.className = 'concept-chip';
        chip.textContent = c;
        chip.style.marginBottom = '4px';
        dc.appendChild(chip);
      });
    }
  }

  const overviewConcepts = document.getElementById('overviewConcepts');
  if (overviewConcepts) {
    overviewConcepts.innerHTML = '';
    const topConcepts = Array.from(allConcepts).slice(0, 8);
    if (topConcepts.length === 0) {
      overviewConcepts.innerHTML = '<p class="empty-note" style="font-size:0.76rem">Concepts will appear here as you chat.</p>';
    } else {
      topConcepts.forEach(c => {
        const chip = document.createElement('span');
        chip.className = 'concept-chip';
        chip.textContent = c;
        overviewConcepts.appendChild(chip);
      });
    }
  }

  const overviewResources = document.getElementById('overviewResources');
  if (overviewResources) {
    const recentResources = allResources.slice(0, 3);
    overviewResources.innerHTML = recentResources.length
      ? recentResources.map(makeCard).join('')
      : '<p class="empty-note" style="font-size:0.76rem">Recommended resources will appear here as you chat.</p>';
  }
}

function updateDashboard() {
  const dsSessions = document.getElementById('dsSessions');
  if (dsSessions) dsSessions.textContent = chatSessions.length;

  const dsMsgs = document.getElementById('dsMsgs');
  if (dsMsgs) dsMsgs.textContent = usageStats.totalMessages || 0;

  if (quizHistory.length > 0) {
    const avg = Math.round(quizHistory.reduce((a, b) => a + b.score, 0) / quizHistory.length);
    const dsQuizAvg = document.getElementById('dsQuizAvg');
    if (dsQuizAvg) dsQuizAvg.textContent = avg + '%';
  } else {
    const dsQuizAvg = document.getElementById('dsQuizAvg');
    if (dsQuizAvg) dsQuizAvg.textContent = '—';
  }
  const dm = document.getElementById('dashMetrics');
  if (dm) {
    dm.innerHTML = '';
    Object.entries(metrics).forEach(([k, v]) => {
      const p = Math.min(v, 100);
      dm.innerHTML += `<div class="metric-item"><div class="metric-top"><span class="metric-name">${METRIC_LABELS[k]}</span><span class="metric-val">${p}%</span></div><div class="metric-bar"><div class="metric-fill" style="width:${p}%"></div></div></div>`;
    });
  }
  const qh = document.getElementById('dashQuizHist');
  if (qh) {
    qh.innerHTML = quizHistory.length === 0
      ? '<p class="empty-note" style="font-size:0.76rem">No quizzes taken yet.</p>'
      : quizHistory.map(q => `<div class="quiz-hist-item"><span><span class="qhi-badge" style="background:${QUIZ_TYPE_META[q.type]?.color || '#666'}22;color:${QUIZ_TYPE_META[q.type]?.color || '#666'}">${QUIZ_TYPE_META[q.type]?.label || 'Quiz'}</span>${escHtml(q.topic)}</span><span style="font-weight:600;color:var(--accent)">${q.score}%</span></div>`).join('');
  }
  
  // 🔧 FIX: Explicitly update bloom count labels so numbers match the chart
  for (let level = 1; level <= 6; level++) {
    const countEl = document.getElementById(`blc-${level}`);
    if (countEl) {
      countEl.textContent = bloomCounts[level] || 0;
    }
  }
  
  buildStreak();
  drawRadar();
  drawBloomChart();
}

function buildStreak() {
  const row = document.getElementById('streakRow');
  if (!row) return;
  row.innerHTML = '';
  const today = new Date();
  const recentDays = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const ds = d.toISOString().split('T')[0];
    recentDays.push(ds);
    const div = document.createElement('div');
    const isActive = sessionActivity.includes(ds);
    div.className = 'streak-day' + (isActive ? ' active' : '') + (i === 0 ? ' today' : '');
    div.title = ds;
    row.appendChild(div);
  }
  const activeRecentDays = recentDays.filter(ds => sessionActivity.includes(ds)).length;
  const streakLbl = document.getElementById('streakLbl');
  if (streakLbl) {
    streakLbl.textContent = `${activeRecentDays} active day${activeRecentDays === 1 ? '' : 's'} in the last 7 · ${usageStats.totalMessages || 0} total messages · ${chatSessions.length} chats`;
  }
}

function drawRadar() {
  const canvas = document.getElementById('radarCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 250, 190);
  const cx = 125, cy = 95, r = 68;
  const keys = Object.keys(metrics);
  const angles = keys.map((_, i) => (i / keys.length) * 2 * Math.PI - Math.PI / 2);
  for (let ring = 1; ring <= 4; ring++) {
    ctx.beginPath();
    angles.forEach((a, i) => { const x = cx + (r * ring / 4) * Math.cos(a), y = cy + (r * ring / 4) * Math.sin(a); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.closePath(); ctx.strokeStyle = 'rgba(18,16,14,0.08)'; ctx.lineWidth = 1; ctx.stroke();
  }
  const lbls = ['Depth', 'Assumptions', 'Counter', 'Evidence', 'Clarity'];
  ctx.font = '8.5px IBM Plex Sans'; ctx.fillStyle = '#6b6356'; ctx.textAlign = 'center';
  angles.forEach((a, i) => {
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    ctx.strokeStyle = 'rgba(18,16,14,0.09)'; ctx.stroke();
    ctx.fillText(lbls[i], cx + (r + 15) * Math.cos(a), cy + (r + 15) * Math.sin(a) + 3);
  });
  const vals = keys.map(k => Math.min(metrics[k], 100) / 100);
  ctx.beginPath();
  angles.forEach((a, i) => { const x = cx + r * vals[i] * Math.cos(a), y = cy + r * vals[i] * Math.sin(a); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.closePath(); ctx.fillStyle = 'rgba(184,58,26,0.13)'; ctx.fill(); ctx.strokeStyle = '#b83a1a'; ctx.lineWidth = 2; ctx.stroke();
  angles.forEach((a, i) => { const x = cx + r * vals[i] * Math.cos(a), y = cy + r * vals[i] * Math.sin(a); ctx.beginPath(); ctx.arc(x, y, 3, 0, 2 * Math.PI); ctx.fillStyle = '#b83a1a'; ctx.fill(); });
}

function drawBloomChart() {
  const canvas = document.getElementById('bloomChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 330, 120);
  const levels = [1, 2, 3, 4, 5, 6];
  const max = Math.max(...levels.map(l => bloomCounts[l]), 1);
  const barW = 36, gap = 19, startX = 18, baseY = 95;
  levels.forEach((l, i) => {
    const x = startX + i * (barW + gap);
    const h = Math.round((bloomCounts[l] / max) * 70) + 2;
    ctx.fillStyle = BLOOM_COLORS[l] + '33'; ctx.strokeStyle = BLOOM_COLORS[l]; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(x, baseY - h, barW, h, 4); ctx.fill(); ctx.stroke();
    ctx.font = '8px IBM Plex Sans'; ctx.fillStyle = '#6b6356'; ctx.textAlign = 'center';
    ctx.fillText(BLOOM_NAMES[l].substring(0, 5), x + barW / 2, 110);
    if (bloomCounts[l] > 0) { ctx.font = 'bold 9px IBM Plex Sans'; ctx.fillStyle = BLOOM_COLORS[l]; ctx.fillText(bloomCounts[l], x + barW / 2, baseY - h - 3); }
  });
}

// ════════════════════════════════════════
// BLOOM
// ════════════════════════════════════════
function updateBloomBadge(level) {
  const badge = document.getElementById('bloomBadge');
  if (!badge) return;
  badge.style.display = 'flex';
  badge.style.background = BLOOM_COLORS[level] + '22';
  badge.style.borderColor = BLOOM_COLORS[level] + '55';
  badge.style.color = BLOOM_COLORS[level];
  badge.textContent = `${['①', '②', '③', '④', '⑤', '⑥'][level - 1]} ${BLOOM_NAMES[level] || ''}`;
}

function updateBloomDash(level) {
  for (let i = 1; i <= 6; i++) {
    const el = document.getElementById(`bl-${i}`);
    if (el) el.classList.toggle('active', i === level);
  }
  const cnt = document.getElementById(`blc-${level}`);
  if (cnt) cnt.textContent = bloomCounts[level];
}

// ════════════════════════════════════════
// CHAT — rendering helpers
// ════════════════════════════════════════
function hideWelcome() { const w = document.getElementById('welcome'); if (w) w.style.display = 'none'; }
function scrollBottom() { const m = document.getElementById('messages'); if (m) m.scrollTop = m.scrollHeight; }
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// 🔧 FIX: More robust extractRawText to handle all OpenRouter response formats
function extractRawText(responseData) {
  if (!responseData) return '';
  
  // Handle direct string (fallback)
  if (typeof responseData === 'string') return responseData.trim();
  
  // Handle OpenRouter/Claude format: { content: [{ type: 'text', text: '...' }] }
  if (Array.isArray(responseData.content)) {
    return responseData.content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('')
      .trim();
  }
  
  // Handle direct message content (other providers)
  if (responseData.message?.content) return responseData.message.content;
  if (responseData.choices?.[0]?.message?.content) {
    return responseData.choices[0].message.content;
  }
  
  // Handle nested content object
  if (responseData.content?.text) return responseData.content.text;
  
  // Last resort: stringify and try to extract JSON answer
  try {
    const str = JSON.stringify(responseData);
    const jsonMatch = str.match(/\{[\s\S]*"answer"[\s\S]*\}/);
    if (jsonMatch) return jsonMatch[0];
  } catch (e) {}
  
  return JSON.stringify(responseData);
}

// 🔧 FIX: Defensive plain-text handling in normalizeAIResponse
function normalizeAIResponse(raw) {
  const trimmed = (raw || '').trim();
  const fallbackAnswer = trimmed || 'No answer text was returned by Claude.';

  if (!trimmed) {
    return {
      answer: fallbackAnswer,
      bloom_level: null,
      bloom_label: '',
      thinking_insight: '',
      challenge_question: '',
      metrics: getEmptyMetrics(),
      fallacies_detected: [],
      framework_suggested: null,
      concepts: [],
      resources: []
    };
  }

  // 🔧 FIX: If response doesn't look like JSON, treat as plain answer
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) {
    return {
      answer: trimmed,
      bloom_level: null,
      bloom_label: '',
      thinking_insight: '',
      challenge_question: '',
      metrics: getEmptyMetrics(),
      fallacies_detected: [],
      framework_suggested: null,
      concepts: [],
      resources: []
    };
  }

  try {
    const cleaned = trimmed.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (firstError) {
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } else {
        throw firstError;
      }
    }
    const answer = parsed.answer || parsed.response || parsed.content || parsed.message || parsed.text || fallbackAnswer;
    const bloomLevel = Number(parsed.bloom_level || parsed.level) || null;

    return {
      ...parsed,
      answer,
      bloom_level: bloomLevel,
      bloom_label: parsed.bloom_label || parsed.level_label || parsed.label || (bloomLevel ? BLOOM_NAMES[bloomLevel] : '')
    };
  } catch (error) {
    console.warn('Could not parse Claude response as JSON:', error, trimmed);
    return {
      answer: fallbackAnswer,
      bloom_level: null,
      bloom_label: '',
      thinking_insight: '',
      challenge_question: '',
      metrics: getEmptyMetrics(),
      fallacies_detected: [],
      framework_suggested: null,
      concepts: [],
      resources: []
    };
  }
}

function coerceMessageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item.text === 'string') return item.text;
      if (item && typeof item.content === 'string') return item.content;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.answer === 'string') return content.answer;
    if (typeof content.content === 'string') return content.content;
    try {
      return JSON.stringify(content);
    } catch (error) {
      return String(content);
    }
  }
  return content == null ? '' : String(content);
}

function parseStoredAssistantMessage(rawContent, fallbackBloomLevel = null) {
  const normalizedContent = coerceMessageText(rawContent).trim();
  if (!normalizedContent) {
    return {
      answer: '',
      bloom_level: fallbackBloomLevel
    };
  }

  try {
    const parsed = normalizeAIResponse(normalizedContent);
    return {
      answer: parsed.answer || normalizedContent,
      bloom_level: parsed.bloom_level || fallbackBloomLevel,
      bloom_label: parsed.bloom_label || '',
      thinking_insight: parsed.thinking_insight || '',
      challenge_question: parsed.challenge_question || '',
      metrics: parsed.metrics || null,
      fallacies_detected: parsed.fallacies_detected || [],
      framework_suggested: parsed.framework_suggested || null,
      concepts: parsed.concepts || [],
      resources: parsed.resources || []
    };
  } catch (error) {
    return {
      answer: normalizedContent,
      bloom_level: fallbackBloomLevel
    };
  }
}

function sanitizeConversationForAPI(history) {
  return history.map(msg => {
    if (msg.role === 'assistant') {
      const parsedAssistant = parseStoredAssistantMessage(msg.content, msg.bloom_level);
      return { role: 'assistant', content: parsedAssistant.answer || coerceMessageText(msg.content) };
    }
    return { role: 'user', content: coerceMessageText(msg.content) };
  }).filter(msg => msg.content && msg.content.trim());
}

function renderSessionMetrics() {
  const ml = document.getElementById('metricsList');
  if (!ml) return;

  ml.innerHTML = '';
  Object.entries(metrics).forEach(([k, v]) => {
    const p = Math.min(v, 100);
    ml.innerHTML += `<div class="metric-item"><div class="metric-top"><span class="metric-name" style="font-size:0.74rem">${METRIC_LABELS[k]}</span><span class="metric-val">${p}%</span></div><div class="metric-bar"><div class="metric-fill" style="width:${p}%"></div></div></div>`;
  });
}

function renderSessionFrameworks() {
  const el = document.getElementById('frameworksList');
  if (!el) return;

  el.innerHTML = '';
  if (frameworks.size === 0) {
    el.innerHTML = '<p class="empty-note">Thinking frameworks will be suggested here.</p>';
    return;
  }

  frameworks.forEach((description, name) => {
    const c = document.createElement('div');
    c.className = 'fw-card';
    c.innerHTML = `<strong>${escHtml(name)}</strong>${escHtml(description)}`;
    el.appendChild(c);
  });
}

function renderSessionFallacies() {
  const fl = document.getElementById('fallaciesList');
  if (!fl) return;

  fl.innerHTML = '';
  if (allFallacies.size === 0) {
    fl.innerHTML = '<p class="empty-note">Logical fallacies will appear here.</p>';
    return;
  }

  allFallacies.forEach(f => {
    const t = document.createElement('span');
    t.className = 'fallacy-tag';
    t.textContent = '⚠ ' + escHtml(f);
    fl.appendChild(t);
  });
}

function renderSessionSources() {
  const chipsContainer = document.getElementById('conceptChips');
  const resourcesContainer = document.getElementById('resourcesList');

  if (chipsContainer) {
    chipsContainer.innerHTML = '';
    if (allConcepts.size === 0) {
      chipsContainer.innerHTML = '<p class="empty-note" style="font-size:0.75rem">Concepts will appear as you chat.</p>';
    } else {
      allConcepts.forEach(c => {
        const chip = document.createElement('span');
        chip.className = 'concept-chip';
        chip.textContent = escHtml(c);
        chipsContainer.appendChild(chip);
      });
    }
  }

  if (resourcesContainer) {
    resourcesContainer.innerHTML = '';
    if (allResources.length === 0) {
      resourcesContainer.innerHTML = '<p class="empty-note" style="font-size:0.75rem">Resources will appear as you chat.</p>';
    } else {
      allResources.forEach(r => {
        const card = document.createElement('div');
        card.className = 'resource-card';
        let content = `<div class="rc-title">${escHtml(r.title)}</div><div class="rc-sub">${escHtml(r.author || r.channel || r.source || '')}</div>`;

        if (r.type === 'video' && (r.channel || r.title)) {
          card.innerHTML = `<div class="rc-type video">▶️ Video</div>${content}`;
          card.onclick = () => searchYouTube(r.title, r.channel);
          card.style.cursor = 'pointer';
        } else {
          card.innerHTML = `<div class="rc-type ${r.type}">${r.type === 'book' ? '📚 Book' : r.type === 'article' ? '📄 Article' : '▶️ Video'}</div>${content}`;
        }
        resourcesContainer.appendChild(card);
      });
    }
  }
}

function resetSessionSidebarState() {
  metrics = getEmptyMetrics();
  // FIX 5: Reset bloomCounts when switching sessions so they don't bleed over
  bloomCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  allFallacies = new Set();
  frameworks = new Map();
  allConcepts = new Set();
  allResources = [];
  renderSessionMetrics();
  renderSessionFallacies();
  renderSessionFrameworks();
  renderSessionSources();
}

function applySessionInsights(parsed) {
  if (parsed.metrics) {
    Object.keys(parsed.metrics).forEach(k => {
      if (metrics[k] !== undefined) {
        metrics[k] = Math.min(100, metrics[k] + (parsed.metrics[k] || 0));
      }
    });
  }

  if (Array.isArray(parsed.fallacies_detected)) {
    parsed.fallacies_detected.forEach(f => allFallacies.add(f));
  }

  if (parsed.framework_suggested && parsed.framework_suggested.name && !frameworks.has(parsed.framework_suggested.name)) {
    frameworks.set(parsed.framework_suggested.name, parsed.framework_suggested.description || '');
  }

  if (Array.isArray(parsed.concepts)) {
    parsed.concepts.forEach(c => allConcepts.add(c));
  }

  if (Array.isArray(parsed.resources)) {
    parsed.resources.forEach(r => {
      if (!allResources.some(x => x.title === r.title && x.type === r.type)) {
        allResources.push(r);
      }
    });
  }
}

function appendUserMsg(text) {
  hideWelcome();
  const m = document.getElementById('messages');
  if (!m) return;
  const d = document.createElement('div');
  d.className = 'msg-row user';
  d.innerHTML = `<div class="av" style="background:var(--ink);color:white">G</div><div class="bubble">${escHtml(text)}</div>`;
  m.appendChild(d); scrollBottom();
}

function appendAIMsg(data) {
  const m = document.getElementById('messages');
  if (!m) return;
  const wrap = document.createElement('div');
  wrap.className = 'ai-wrap';
  const col = document.createElement('div');
  col.className = 'ai-col';
  const level = data.bloom_level || 1;
  const color = BLOOM_COLORS[level];
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.style.cssText = 'background:var(--white);border-bottom-left-radius:4px;box-shadow:0 2px 10px rgba(18,16,14,0.07);';
  const answerHtml = escHtml(data.answer || 'No answer text was returned by Claude.').replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>');
  const bloomTag = data.bloom_level
    ? `<div class="bloom-tag" style="background:${color}18;border-color:${color}44;color:${color}">⬡ ${escHtml(data.bloom_label || BLOOM_NAMES[level])}</div>`
    : '';
  bubble.innerHTML = `${bloomTag}<div>${answerHtml}</div>`;
  col.appendChild(bubble);
  if (data.thinking_insight) {
    const ins = document.createElement('div'); ins.className = 'ins-card';
    ins.innerHTML = `<div class="cl">💡 Thinking Insight</div>${escHtml(data.thinking_insight)}`;
    col.appendChild(ins);
  }
  if (data.challenge_question) {
    const ch = document.createElement('div'); ch.className = 'ch-card';
    ch.innerHTML = `<div class="cl">🔍 Challenge — Level Up</div>${escHtml(data.challenge_question)}`;
    col.appendChild(ch);
  }
  wrap.innerHTML = `<div class="av" style="background:var(--accent);color:white;font-family:'Lora',serif;font-style:italic;">T</div>`;
  wrap.appendChild(col);
  m.appendChild(wrap); scrollBottom();
}

function showTyping() {
  hideWelcome();
  const m = document.getElementById('messages');
  if (!m) return;
  const w = document.createElement('div'); w.id = 'typingWrap'; w.className = 'typing-wrap';
  w.innerHTML = `<div class="av" style="background:var(--accent);color:white;font-family:'Lora',serif;font-style:italic;">T</div><div class="typing"><span></span><span></span><span></span></div>`;
  m.appendChild(w); scrollBottom();
}
function removeTyping() { const el = document.getElementById('typingWrap'); if (el) el.remove(); }

function updateSidebar(data) {
  applySessionInsights(data);
  renderSessionMetrics();
  renderSessionFallacies();
  renderSessionFrameworks();
  if (data.bloom_level && BLOOM_COLORS[data.bloom_level]) {
    const level = data.bloom_level;
    bloomCounts[level] = (bloomCounts[level] || 0) + 1;
    updateBloomBadge(level);
    updateBloomDash(level);
  }
  saveState();
}

// ════════════════════════════════════════
// CHAT — send message
// ════════════════════════════════════════
async function sendMessage() {
  const input = document.getElementById('userInput')?.value.trim();
  if (!input) return;
  const inputEl = document.getElementById('userInput');
  if (inputEl) {
    inputEl.value = '';
    inputEl.style.height = 'auto';
  }
  const sendBtn = document.getElementById('sendBtn');
  if (sendBtn) sendBtn.disabled = true;

  appendUserMsg(input);
  conversationHistory.push({ role: 'user', content: input });

  // If no session yet, create one automatically
  if (!currentSessionId) {
    try {
      const res = await apiPost('/api/sessions', { title: 'New Chat' });
      if (res && res.id) {
        currentSessionId = res.id;
        chatSessions.unshift({
          id: res.id,
          title: res.title || 'New Chat',
          created_at: new Date().toISOString()
        });
      }
    } catch (e) {
      console.warn('Session creation failed:', e);
    }
  }

  // FIX 6: Show typing indicator before API call, increment counts only after success
  showTyping();

  try {
    const systemPrompt = getSystemPrompt(currentGoal);
    const rd = await callAPI(sanitizeConversationForAPI(conversationHistory), systemPrompt, 1200);
    const raw = extractRawText(rd);
    removeTyping();

    const parsed = normalizeAIResponse(raw);

    // FIX 6: Increment counts only after a successful API response
    msgCount++;
    usageStats.totalMessages += 1;

    conversationHistory.push({
      role: 'assistant',
      content: parsed.answer || raw,
      raw_content: raw,
      bloom_level: parsed.bloom_level || null,
      bloom_label: parsed.bloom_label || '',
      thinking_insight: parsed.thinking_insight || '',
      challenge_question: parsed.challenge_question || '',
      metrics: parsed.metrics || null,
      fallacies_detected: parsed.fallacies_detected || [],
      framework_suggested: parsed.framework_suggested || null,
      concepts: parsed.concepts || [],
      resources: parsed.resources || []
    });

    appendAIMsg(parsed);
    updateSidebar(parsed);
    updateSources(parsed);
    renderChatList();
    syncCurrentSessionCache();
    saveState();

    if (msgCount === 1) {
      generateChatTitle();
    }

    const quizFreq = window.QUIZ_FREQUENCY || 6;
    if (quizFreq > 0 && msgCount > 0 && msgCount % quizFreq === 0) {
      setTimeout(() => triggerQuiz('mid'), 1200);
    }

  } catch (err) {
    removeTyping();
    console.error('API error:', err);
    showToast('warn', 'Connection error', err.message || 'Could not reach ThinkIA. Make sure the backend is running.', 6000);
  }

  if (sendBtn) sendBtn.disabled = false;
  if (inputEl) inputEl.focus();
  const today = new Date().toISOString().split('T')[0];
  if (!sessionActivity.includes(today)) sessionActivity.push(today);
  saveState();
}

async function generateChatTitle() {
  if (!currentSessionId) return;

  try {
    const res = await apiPost(`/api/sessions/${currentSessionId}/generate-title`, {});
    if (res.title && chatSessions[currentChatIndex]) {
      chatSessions[currentChatIndex].title = res.title;
      renderChatList();

      const sessionIdx = chatSessions.findIndex(s => s.id === currentSessionId);
      if (sessionIdx >= 0) {
        chatSessions[sessionIdx].title = res.title;
      }
      saveState();
    }
  } catch (err) {
    console.warn('Failed to generate title:', err);
  }
}

function sendStarter(btn) {
  const inputEl = document.getElementById('userInput');
  if (inputEl) inputEl.value = btn.textContent;
  sendMessage();
}

// ════════════════════════════════════════
// QUIZ
// ════════════════════════════════════════
async function triggerQuiz(type = 'mid') {
  if (conversationHistory.length < 2) {
    showToast('info', 'Not enough conversation yet', 'Have a few exchanges first before taking a quiz!', 4000);
    return;
  }

  const n = QUIZ_TYPE_META[type].n;
  showToast('info', '⏳ Generating quiz…', 'Building questions from your conversation…', 3000);

  // FIX 3: Use sanitizeConversationForAPI to avoid raw JSON objects in history
  const quizMessages = [
    ...sanitizeConversationForAPI(conversationHistory),
    {
      role: 'user',
      content: `Based on our conversation, generate exactly ${n} multiple-choice questions to test recall and understanding. Return ONLY valid JSON, no backticks:\n{"topic":"2-4 word topic","questions":[{"q":"Question","options":["A","B","C","D"],"correct":0,"explanation":"Why correct and why others are wrong."}]}`
    }
  ];

  try {
    const rd = await callAPI(quizMessages, '', 2000);
    const raw = extractRawText(rd);

    console.log('Quiz raw response:', raw);

    const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const qdata = JSON.parse(clean);
    qdata.type = type;
    showQuiz(qdata);

  } catch (e) {
    console.error('Quiz generation error:', e);
    showToast('warn', 'Quiz error', 'Could not generate quiz. Try again after more conversation.', 4000);
  }
}

function showQuiz(data) {
  quizData = data;
  quizState = { qIdx: 0, answers: [], active: true };
  const ov = document.getElementById('quizOverlay');
  if (!ov) return;
  ov.style.display = 'flex';
  renderQ();
}

function renderQ() {
  const ov = document.getElementById('quizOverlay');
  if (!ov || !quizData) return;
  const q = quizData.questions[quizState.qIdx];
  const total = quizData.questions.length;
  const meta = QUIZ_TYPE_META[quizData.type || 'mid'];
  const pips = quizData.questions.map((_, i) => `<div class="qpip${i < quizState.qIdx ? ' done' : i === quizState.qIdx ? ' active' : ''}"></div>`).join('');
  ov.innerHTML = `<div class="quiz-box">
    <div class="quiz-header">
      <div class="quiz-type-badge" style="background:${meta.color}18;color:${meta.color}">${meta.label}</div>
      <h2>Active Recall Quiz</h2>
      <p>${escHtml(quizData.topic)} · Question ${quizState.qIdx + 1} of ${total}</p>
      <div class="qprog">${pips}</div>
    </div>
    <div class="quiz-body">
      <div class="q-num">Question ${quizState.qIdx + 1}</div>
      <div class="q-text">${escHtml(q.q)}</div>
      <div class="q-opts">${q.options.map((o, i) => `<button class="q-opt" onclick="answerQ(${i})">${escHtml(o)}</button>`).join('')}</div>
      <div id="qExpl" style="display:none"></div>
    </div>
    <div class="quiz-nav">
      <button class="qbtn ghost" onclick="closeQuiz()">Skip quiz</button>
      <button class="qbtn primary" id="qNext" style="display:none" onclick="nextQ()">${quizState.qIdx + 1 < total ? 'Next →' : 'See Results'}</button>
    </div>
  </div>`;
}

function answerQ(idx) {
  const q = quizData.questions[quizState.qIdx];
  quizState.answers.push(idx);
  document.querySelectorAll('.q-opt').forEach(o => o.disabled = true);
  const opts = document.querySelectorAll('.q-opt');
  if (opts[idx]) opts[idx].classList.add(idx === q.correct ? 'correct' : 'wrong');
  if (idx !== q.correct && opts[q.correct]) opts[q.correct].classList.add('reveal');
  const expl = document.getElementById('qExpl');
  if (expl) {
    expl.style.display = 'block'; expl.className = 'q-expl';
    expl.innerHTML = (idx === q.correct ? '✅ Correct! ' : '❌ Not quite. ') + escHtml(q.explanation);
  }
  const nb = document.getElementById('qNext');
  if (nb) {
    nb.style.display = 'block';
    nb.textContent = quizState.qIdx + 1 < quizData.questions.length ? 'Next →' : 'See Results';
  }
}

function nextQ() {
  quizState.qIdx++;
  if (quizState.qIdx >= quizData.questions.length) showResults();
  else renderQ();
}

function showResults() {
  const correct = quizState.answers.filter((a, i) => a === quizData.questions[i].correct).length;
  const total = quizData.questions.length;
  const pct = Math.round(correct / total * 100);
  quizHistory.push({ type: quizData.type || 'mid', topic: quizData.topic, score: pct });
  saveState();
  const msg = pct === 100 ? 'Perfect! Exceptional recall.' : pct >= 80 ? 'Strong retention. You\'re learning deeply.' : pct >= 60 ? 'Good effort. Review the missed questions.' : 'Keep engaging — recall strengthens with practice.';
  const fb = quizData.questions.map((q, i) => {
    const pass = quizState.answers[i] === q.correct;
    return `<div class="qf-item ${pass ? 'pass' : 'fail'}">${pass ? '✅' : '❌'} ${escHtml(q.q)}</div>`;
  }).join('');
  const ov = document.getElementById('quizOverlay');
  if (ov) {
    ov.innerHTML = `<div class="quiz-box">
    <div class="score-screen">
      <div class="score-ring"><span class="score-big">${pct}%</span><span class="score-sub">${correct}/${total}</span></div>
      <h3>${msg}</h3>
      <p>Active recall strengthens long-term retention. The effort of remembering is what cements knowledge.</p>
      <div class="qf-list">${fb}</div>
    </div>
    <div class="quiz-nav" style="justify-content:center;padding-top:0">
      <button class="qbtn primary" onclick="closeQuiz()">Back to Chat</button>
    </div>
  </div>`;
  }
}

function closeQuiz() {
  const ov = document.getElementById('quizOverlay');
  if (ov) ov.style.display = 'none';
}

// ════════════════════════════════════════
// RANDOM STARTERS
// ════════════════════════════════════════
async function initRandomStarters() {
  const startersEl = document.getElementById('starters');
  if (!startersEl) return;

  startersEl.innerHTML = '<p class="empty-note" style="font-size:0.8rem">Loading personalized questions...</p>';

  try {
    const questions = await fetchStarterQuestions();
    startersEl.innerHTML = '';

    questions.slice(0, 5).forEach(q => {
      const btn = document.createElement('button');
      btn.className = 'starter';
      btn.textContent = q;
      btn.onclick = () => sendStarter(btn);
      startersEl.appendChild(btn);
    });
  } catch (err) {
    console.warn('Failed to load starters:', err);
    startersEl.innerHTML = '';
    FALLBACK_STARTERS.forEach(q => {
      const btn = document.createElement('button');
      btn.className = 'starter';
      btn.textContent = q;
      btn.onclick = () => sendStarter(btn);
      startersEl.appendChild(btn);
    });
  }
}

// ════════════════════════════════════════
// USER DATA LOADERS
// ════════════════════════════════════════
async function loadUserMetrics(options = {}) {
  const { persist = true } = options;

  try {
    const metricsData = await apiGet('/api/metrics');
    if (metricsData && metricsData._id) {
      metrics = {
        depth: metricsData.depth || 0,
        assumptions: metricsData.assumptions || 0,
        counterargument: metricsData.counterargument || 0,
        evidence: metricsData.evidence || 0,
        clarity: metricsData.clarity || 0
      };
      bloomCounts = {
        1: typeof metricsData.bloom_remember === 'number' ? metricsData.bloom_remember : 0,
        2: typeof metricsData.bloom_understand === 'number' ? metricsData.bloom_understand : 0,
        3: typeof metricsData.bloom_apply === 'number' ? metricsData.bloom_apply : 0,
        4: typeof metricsData.bloom_analyse === 'number' ? metricsData.bloom_analyse : 0,
        5: typeof metricsData.bloom_evaluate === 'number' ? metricsData.bloom_evaluate : 0,
        6: typeof metricsData.bloom_create === 'number' ? metricsData.bloom_create : 0
      };
      // 🔧 FIX: Sync usageStats from backend metrics
      usageStats = {
        totalMessages: typeof metricsData.total_messages === 'number' 
          ? metricsData.total_messages 
          : (usageStats.totalMessages || 0),
        totalSessions: typeof metricsData.total_sessions === 'number'
          ? metricsData.total_sessions
          : (usageStats.totalSessions || 0)
      };
      if (persist) saveState();
    }
  } catch (err) {
    console.warn('Failed to load metrics:', err);
  }
}

function updateMetricsDisplay() {
  const ml = document.getElementById('metricsList');
  if (!ml) return;

  ml.innerHTML = '';
  Object.entries(metrics).forEach(([k, v]) => {
    const p = Math.min(v, 100);
    ml.innerHTML += `<div class="metric-item"><div class="metric-top"><span class="metric-name">${METRIC_LABELS[k]}</span><span class="metric-val">${p}%</span></div><div class="metric-bar"><div class="metric-fill" style="width:${p}%"></div></div></div>`;
  });
}

async function loadUserResources(options = {}) {
  const { persist = true } = options;

  try {
    const resources = await apiGet('/api/resources');
    if (Array.isArray(resources)) {
      allResources = resources;
      if (persist) saveState();
    }
  } catch (err) {
    console.warn('Failed to load resources:', err);
  }
}

async function loadUserConcepts(options = {}) {
  const { persist = true } = options;

  try {
    const concepts = await apiGet('/api/concepts');
    if (Array.isArray(concepts)) {
      allConcepts = new Set(concepts);
      if (persist) saveState();
    }
  } catch (err) {
    console.warn('Failed to load concepts:', err);
  }
}

function renderSidebarResources() {
  const chipsContainer = document.getElementById('conceptChips');
  const resourcesContainer = document.getElementById('resourcesList');

  if (chipsContainer && allConcepts.size > 0) {
    chipsContainer.innerHTML = '';
    allConcepts.forEach(c => {
      const chip = document.createElement('span');
      chip.className = 'concept-chip';
      chip.textContent = escHtml(c);
      chipsContainer.appendChild(chip);
    });
  }

  if (resourcesContainer && allResources.length > 0) {
    resourcesContainer.innerHTML = '';
    allResources.forEach(r => {
      const card = document.createElement('div');
      card.className = 'resource-card';

      let content = `<div class="rc-title">${escHtml(r.title)}</div><div class="rc-sub">${escHtml(r.author || r.channel || r.source || '')}</div>`;

      if (r.type === 'video' && (r.channel || r.title)) {
        card.innerHTML = `<div class="rc-type video">▶️ Video</div>${content}`;
        card.onclick = () => searchYouTube(r.title, r.channel);
        card.style.cursor = 'pointer';
      } else {
        card.innerHTML = `<div class="rc-type ${r.type}">${r.type === 'book' ? '📚 Book' : r.type === 'article' ? '📄 Article' : '▶️ Video'}</div>${content}`;
      }
      resourcesContainer.appendChild(card);
    });
  }
}

// ════════════════════════════════════════
// CHAT SESSIONS
// ════════════════════════════════════════
async function createNewChat() {
  try {
    const res = await apiPost('/api/sessions', { title: 'New Chat' });
    if (res?.id) {
      currentSessionId = res.id;
      chatSessions.unshift({
        id: res.id,
        title: res.title,
        goal: currentGoal,
        created_at: res.created_at,
        messages: []
      });
      usageStats.totalSessions = chatSessions.length;
      currentChatIndex = 0;
      conversationHistory = [];
      msgCount = 0;
      resetSessionSidebarState();

      showWelcome();
      renderChatList();
      saveState();
    }
  } catch (err) {
    console.warn('Failed to create session:', err);
    showToast('warn', 'Error', 'Could not create new chat session.', 4000);
  }
}

async function loadChatSession(sessionId) {
  // FIX 4: Guard against rapid session switching causing mixed messages
  if (isLoadingSession) return;
  isLoadingSession = true;

  try {
    currentSessionId = sessionId;
    currentChatIndex = chatSessions.findIndex(s => s.id === sessionId);
    const cachedSession = sessionCache[sessionId] || null;
    resetSessionSidebarState();

    let sessionMessages = [];
    try {
      const messages = await apiGet(`/api/sessions/${sessionId}/messages`);
      sessionMessages = Array.isArray(messages) ? messages : [];
    } catch (err) {
      sessionMessages = [];
    }

    if (sessionMessages.length === 0 && cachedSession?.messages?.length) {
      sessionMessages = cachedSession.messages;
    }

    conversationHistory = sessionMessages.map(m => {
      if (m.role === 'assistant') {
        const parsedAssistant = parseStoredAssistantMessage(m.raw_content || m.content, m.bloom_level);
        applySessionInsights(parsedAssistant);
        return {
          role: 'assistant',
          content: parsedAssistant.answer,
          bloom_level: parsedAssistant.bloom_level,
          bloom_label: parsedAssistant.bloom_label,
          thinking_insight: parsedAssistant.thinking_insight,
          challenge_question: parsedAssistant.challenge_question,
          metrics: parsedAssistant.metrics,
          fallacies_detected: parsedAssistant.fallacies_detected,
          framework_suggested: parsedAssistant.framework_suggested,
          concepts: parsedAssistant.concepts,
          resources: parsedAssistant.resources,
          raw_content: m.raw_content || m.content
        };
      }

      return {
        role: m.role,
        content: coerceMessageText(m.content),
        bloom_level: m.bloom_level
      };
    });
    msgCount = sessionMessages.filter(m => m.role === 'user').length;

    let goalData = null;
    try {
      goalData = await apiGet(`/api/sessions/${sessionId}/goal`);
    } catch (err) {
      goalData = null;
    }

    if ((!goalData || !goalData.goal) && cachedSession?.goal) {
      goalData = { goal: cachedSession.goal };
    }

    if (goalData && goalData.goal) {
      currentGoal = goalData.goal;
      const goalIndicator = document.getElementById('goalIndicator');
      const goalText = document.getElementById('goalText');
      if (goalIndicator) goalIndicator.style.display = 'flex';
      if (goalText) goalText.textContent = goalData.goal.length > 30 ? goalData.goal.substring(0, 30) + '...' : goalData.goal;
    } else {
      currentGoal = null;
      const goalIndicator = document.getElementById('goalIndicator');
      if (goalIndicator) goalIndicator.style.display = 'none';
    }

    const messagesEl = document.getElementById('messages');
    if (messagesEl) {
      messagesEl.innerHTML = '';

      if (conversationHistory.length === 0) {
        showWelcome();
      } else {
        conversationHistory.forEach(msg => {
          if (msg.role === 'user') {
            appendUserMsg(msg.content);
          } else {
            // Original JSON rendering fix — parse stored content before rendering
            const parsed = parseStoredAssistantMessage(
              msg.raw_content || msg.content,
              msg.bloom_level
            );
            appendAIMsg({
              answer: parsed.answer || msg.content,
              bloom_level: parsed.bloom_level || msg.bloom_level,
              bloom_label: parsed.bloom_label || msg.bloom_label,
              thinking_insight: parsed.thinking_insight || msg.thinking_insight,
              challenge_question: parsed.challenge_question || msg.challenge_question
            });
          }
        });
        scrollBottom();
      }
    }

    renderChatList();
    renderSessionMetrics();
    renderSessionFallacies();
    renderSessionFrameworks();
    renderSessionSources();
    syncCurrentSessionCache();
    saveState();

  } catch (err) {
    console.warn('Failed to load session:', err);
    showToast('warn', 'Error', 'Could not load chat session.', 4000);
  } finally {
    // FIX 4: Always release the guard whether the load succeeded or failed
    isLoadingSession = false;
  }
}

async function deleteChatSession(sessionId, event) {
  event?.stopPropagation();
  try {
    const res = await fetch(buildApiUrl(`/api/sessions/${sessionId}`), {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (!res.ok) {
      addSystemNotification('error', 'Delete Error', 'Could not delete chat session.');
      return;
    }
    chatSessions = chatSessions.filter(s => s.id !== sessionId);
    goals = goals.filter(g => g.session_id !== sessionId);
    delete sessionCache[sessionId];

    if (currentSessionId === sessionId) {
      currentSessionId = null;
      currentChatIndex = -1;
      conversationHistory = [];
      currentGoal = null;

      const goalIndicator = document.getElementById('goalIndicator');
      if (goalIndicator) goalIndicator.style.display = 'none';

      showWelcome();
    }

    usageStats.totalSessions = chatSessions.length;
    renderChatList();
    renderGoalsList();
    saveState();
  } catch (err) {
    console.warn('Failed to delete session:', err);
  }
}

function renderChatList() {
  const list = document.getElementById('chatList');
  if (!list) return;

  if (chatSessions.length === 0) {
    list.innerHTML = '<p class="empty-note" style="padding: 12px; font-size: 0.8rem;">Your conversations will appear here.</p>';
    return;
  }

  // FIX 8: Escape session title to prevent XSS / layout breaks
  list.innerHTML = chatSessions.map(session => {
    const isActive = session.id === currentSessionId;
    const date = new Date(session.created_at).toLocaleDateString();

    return `
      <div class="chat-item ${isActive ? 'active' : ''}" onclick="loadChatSession('${session.id}')">
        <div class="chat-item-icon">
          <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
        </div>
        <div class="chat-item-content">
          <div class="chat-item-title">${escHtml(session.title || 'New Chat')}</div>
          <div class="chat-item-date">${date}</div>
        </div>
        <button class="chat-item-delete" onclick="deleteChatSession('${session.id}', event)">✕</button>
      </div>
    `;
  }).join('');
}

async function loadAllSessions(options = {}) {
  const { persist = true } = options;

  try {
    const sessions = await apiGet('/api/sessions');
    chatSessions = Array.isArray(sessions) ? sessions : [];
    usageStats.totalSessions = chatSessions.length;
    renderChatList();
    if (persist) saveState();
  } catch (err) {
    console.warn('Failed to load sessions:', err);
  }
}

// ════════════════════════════════════════
// AUTO INIT — DOMContentLoaded
// ════════════════════════════════════════
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    // Textarea input handling
    const ta = document.getElementById('userInput');
    if (ta) {
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
      ta.addEventListener('input', () => {
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 90) + 'px';
      });
    }

    // CHAT PAGE
    if (document.getElementById('chatList')) {
      const savedUser = localStorage.getItem('thinkia_user');
      const savedToken = localStorage.getItem('thinkia_token');

      if (savedUser && savedToken) {
        // Already logged in
        currentUser = JSON.parse(savedUser);
        authToken = savedToken;
        profile.name = currentUser.name || 'Guest';
        initGuestProfile();

        const uiAvatar = document.getElementById('uiAvatar');
        const uiName = document.getElementById('uiName');
        const headerAv = document.getElementById('headerAv');
        if (uiAvatar) uiAvatar.textContent = (profile.name || 'G')[0].toUpperCase();
        if (uiName) uiName.textContent = profile.name;
        if (headerAv) headerAv.textContent = (profile.name || 'G')[0].toUpperCase();

        loadAllSessions().then(() => {
          loadUserMetrics().then(() => {
            loadUserResources().then(() => {
              loadUserConcepts().then(() => {
                loadAllGoals().then(() => {
                  renderSidebarResources();
                  renderSessionSources();
                  initRandomStarters();
                  promptGoalAndStartChat();
                });
              });
            });
          });
        });
      } else {
        // Try guest login
        const deviceId = getOrCreateDeviceId();
        const url = buildApiUrl('/api/auth/guest-login');
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: deviceId })
        }).then(res => res.json()).then(data => {
          if (data.token) {
            localStorage.setItem('thinkia_user', JSON.stringify(data.user));
            localStorage.setItem('thinkia_token', data.token);
            currentUser = data.user;
            authToken = data.token;
            profile.name = data.user.name || 'Guest';
            initGuestProfile();

            const uiAvatar = document.getElementById('uiAvatar');
            const uiName = document.getElementById('uiName');
            const headerAv = document.getElementById('headerAv');
            if (uiAvatar) uiAvatar.textContent = 'G';
            if (uiName) uiName.textContent = 'Guest';
            if (headerAv) headerAv.textContent = 'G';

            loadAllSessions().then(() => {
              loadUserMetrics().then(() => {
                loadAllGoals().then(() => {
                  renderSidebarResources();
                  renderSessionSources();
                  initRandomStarters();
                  promptGoalAndStartChat();
                });
              });
            });
          } else {
            window.location.href = 'login.html';
          }
        }).catch(() => {
          window.location.href = 'login.html';
        });
      }
    }

    // DASHBOARD PAGE
    if (document.getElementById('radarCanvas')) {
      const savedUser = localStorage.getItem('thinkia_user');
      const savedToken = localStorage.getItem('thinkia_token');

      if (savedUser && savedToken) {
        const user = JSON.parse(savedUser);
        if (document.getElementById('dashAv')) document.getElementById('dashAv').textContent = (user.name || 'G')[0].toUpperCase();
        if (document.getElementById('dashName')) document.getElementById('dashName').textContent = user.name || 'Guest';
        authToken = savedToken;
        profile.name = user.name || 'Guest';
        refreshDashboard();
        startDashboardRealtimeSync();
      } else {
        // Guest login for dashboard
        const deviceId = getOrCreateDeviceId();
        const url = buildApiUrl('/api/auth/guest-login');
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: deviceId })
        }).then(res => res.json()).then(data => {
          if (data.token) {
            localStorage.setItem('thinkia_user', JSON.stringify(data.user));
            localStorage.setItem('thinkia_token', data.token);
            profile.name = data.user.name || 'Guest';
            if (document.getElementById('dashAv')) document.getElementById('dashAv').textContent = 'G';
            if (document.getElementById('dashName')) document.getElementById('dashName').textContent = 'Guest';
            refreshDashboard();
            startDashboardRealtimeSync();
          } else {
            window.location.href = 'login.html';
          }
        }).catch(() => {
          window.location.href = 'login.html';
        });
      }
    }
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const ta = document.getElementById('userInput');
    if (ta) {
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (typeof sendMessage === 'function') sendMessage();
        }
      });
      ta.addEventListener('input', () => {
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 90) + 'px';
      });
    }

    if (document.getElementById('chatList')) {
      const savedUser = localStorage.getItem('thinkia_user');
      const savedToken = localStorage.getItem('thinkia_token');

      if (savedUser && savedToken) {
        currentUser = JSON.parse(savedUser);
        authToken = savedToken;
        profile.name = currentUser.name;
        initGuestProfile();

        const uiAvatar = document.getElementById('uiAvatar');
        const uiName = document.getElementById('uiName');
        const headerAv = document.getElementById('headerAv');
        if (uiAvatar) uiAvatar.textContent = profile.name[0].toUpperCase();
        if (uiName) uiName.textContent = profile.name;
        if (headerAv) headerAv.textContent = profile.name[0].toUpperCase();

        Promise.all([
          loadAllSessions(),
          loadUserMetrics(),
          loadUserResources(),
          loadUserConcepts(),
          loadAllGoals()
        ]).then(() => {
          renderSidebarResources();
          renderSessionSources();
          initRandomStarters();

          const urlParams = new URLSearchParams(window.location.search);
          const sessionId = urlParams.get('session') || currentSessionId;
          if (sessionId) {
            loadChatSession(sessionId);
          } else {
            promptGoalAndStartChat();
          }
        }).catch(err => {
          console.warn('Chat page load error:', err);
          initRandomStarters();
          promptGoalAndStartChat();
        });

      } else {
        // Auto login as guest instead of redirecting
        (async () => {
          try {
            const deviceId = getOrCreateDeviceId();
            const res = await fetch(buildApiUrl('/api/auth/guest-login'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ device_id: deviceId })
            });
            const data = await res.json();
            if (data.token) {
              localStorage.setItem('thinkia_user', JSON.stringify(data.user));
              localStorage.setItem('thinkia_token', data.token);
              currentUser = data.user;
              authToken = data.token;
              profile.name = data.user.name;
              initGuestProfile();

              const uiAvatar = document.getElementById('uiAvatar');
              const uiName = document.getElementById('uiName');
              const headerAv = document.getElementById('headerAv');
              if (uiAvatar) uiAvatar.textContent = 'G';
              if (uiName) uiName.textContent = 'Guest';
              if (headerAv) headerAv.textContent = 'G';

              Promise.all([
                loadAllSessions(),
                loadUserMetrics(),
                loadUserResources(),
                loadUserConcepts(),
                loadAllGoals()
              ]).then(() => {
                renderSidebarResources();
                renderSessionSources();
                initRandomStarters();
                promptGoalAndStartChat();
              }).catch(() => {
                initRandomStarters();
                promptGoalAndStartChat();
              });
            } else {
              window.location.href = 'login.html';
            }
          } catch (e) {
            console.error('Auto guest login failed:', e);
            window.location.href = 'login.html';
          }
        })();
      }
    }

    if (document.getElementById('radarCanvas')) {
      const savedUser = localStorage.getItem('thinkia_user');
      const savedToken = localStorage.getItem('thinkia_token');

      if (savedUser && savedToken) {
        currentUser = JSON.parse(savedUser);
        authToken = savedToken;
        profile.name = currentUser.name;

        const dashAv = document.getElementById('dashAv');
        const dashName = document.getElementById('dashName');
        if (dashAv) dashAv.textContent = profile.name[0].toUpperCase();
        if (dashName) dashName.textContent = profile.name;

        // 🔧 FIX: Show loading state, wait for data before rendering
        const loadingEl = document.getElementById('dashLoading');
        if (loadingEl) loadingEl.classList.remove('hidden');

        Promise.all([
          loadUserMetrics({ persist: true }),
          loadAllSessions({ persist: true }),
          loadUserResources({ persist: true }),
          loadUserConcepts({ persist: true }),
          loadAllGoals()
        ]).then(() => {
          loadDashboardLocalState();
          refreshDashboard(); // Now has complete data
          startDashboardRealtimeSync();
        }).catch(err => {
          console.warn('Dashboard load error:', err);
          addSystemNotification('warn', 'Load Error', 'Some dashboard data may be incomplete.');
          refreshDashboard(); // Render with partial data
        }).finally(() => {
          if (loadingEl) loadingEl.classList.add('hidden');
        });
      } else {
        window.location.href = 'login.html';
      }
    }

    checkBackendHealth();
  });
}

async function checkBackendHealth() {
  try {
    const res = await fetch(buildApiUrl('/health'));
    if (!res.ok) {
      addSystemNotification('warn', 'Backend Warning', 'ThinkIA backend is running but may have issues.');
    }
  } catch (err) {
    addSystemNotification('error', 'Backend Offline', 'Cannot connect to ThinkIA backend. Chat will not save.');
  }
}
