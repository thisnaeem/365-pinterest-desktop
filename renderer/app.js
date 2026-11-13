'use strict';
/* 365 Pinterest — desktop app v2.1.0 renderer.
   Pure local UI. All data comes from the main process (window.desktop),
   which is the only side that talks to the 365 Pinterest REST API.
   Nothing here is faked: every number is from the API, and empty states
   say so honestly. */
const d = window.desktop;

// Genuine Hugeicons glyphs (renderer/icons.js — extracted from the
// website's @hugeicons/core-free-icons package, stroke-width 1.8 exactly
// as the website renders them). ic() returns the inline SVG string.
const ic = (name) => (typeof ICONS !== 'undefined' && ICONS[name]) || '';
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = ic(el.dataset.icon); });
}

const state = {
  screen: 'dashboard',
  hasKey: false,
  user: null,             // signed-in identity { email, name } (null for paste-key)
  account: null,          // /api/v1/account for the active account
  accounts: [],           // discovered accounts [{ id, username, pinterestUserId, needsReconnect }]
  settings: { theme: 'light', accountId: null },
  boards: [],
  boardsLoaded: false,
  pins: [],
  pinsTotal: 0,
  pinStatusFilter: '',
  pinBoardFilter: '',
  pinSearch: '',
  queue: [],
  analytics: null,
  createImage: null,      // { path, name, size, mime, dataUrl }
  version: '',
  update: { status: 'idle', version: null, progress: 0, error: null, lastCheckedAt: null },
  updateBannerDismissedFor: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
const fmtDate = (iso) => {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const fmtDateShort = (iso) => {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};
function timeUntil(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'due now';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3500);
}

function showGlobalError(msg, upgradeUrl) {
  const el = $('global-error');
  if (!msg) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.innerHTML = esc(msg) + (upgradeUrl ? ` <button class="linklike" data-open-external="${esc(upgradeUrl)}">Upgrade to Pro</button>` : '');
  el.classList.remove('hidden');
}

/** Handle an API result. Returns data or null; shows errors + routes 401 to Setup. */
async function handleResult(res, opts = {}) {
  if (res && res.ok) {
    if (!opts.keepError) showGlobalError(null);
    return res.data;
  }
  const msg = (res && res.error) || 'Something went wrong.';
  if (res && res.status === 401) {
    state.hasKey = false;
    state.user = null;
    showScreen('setup');
    const se = $('setup-error');
    se.textContent = msg;
    se.classList.remove('hidden');
    return null;
  }
  showGlobalError(msg, res && res.upgradeUrl);
  return null;
}

function activeAccountId() {
  return state.settings.accountId || null;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const TITLES = {
  setup: 'Connect', dashboard: 'Dashboard', boards: 'Boards', pins: 'Pins',
  create: 'New pin', queue: 'Queue', analytics: 'Analytics', settings: 'Settings',
};

function showScreen(name) {
  if (name !== 'setup' && !state.hasKey) name = 'setup';
  state.screen = name;
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  const el = $('screen-' + name);
  if (el) el.classList.add('active');
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.screen === name);
  });
  $('screen-title').textContent = TITLES[name] || '365 Pinterest';
  $('new-pin-btn').style.display = name === 'create' ? 'none' : '';
  if (location.hash !== '#/' + name) history.replaceState(null, '', '#/' + name);
  if (name === 'dashboard') renderDashboard();
  else if (name === 'boards') renderBoards();
  else if (name === 'pins') renderPins();
  else if (name === 'create') renderCreate();
  else if (name === 'queue') renderQueue();
  else if (name === 'analytics') renderAnalytics();
  else if (name === 'settings') renderSettings();
}

function go(screen) { showScreen(screen); }

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadAccount() {
  const data = await handleResult(await d.getAccount(activeAccountId()));
  if (data) {
    state.account = data;
    updateAccountChip();
  }
  return data;
}

async function loadBoards() {
  const data = await handleResult(await d.listBoards(activeAccountId()));
  if (data) {
    state.boards = data.boards || [];
    state.boardsLoaded = true;
    fillBoardSelects();
  }
  return data;
}

/** Discover extra Pinterest accounts from pins (the REST API has no
 *  list-accounts endpoint for API keys). Each pin carries accountId; resolve
 *  each distinct id to a username via /api/v1/account?account_id=. */
async function discoverAccounts() {
  const found = new Map();
  if (state.account && state.account.pinterestUserId) {
    found.set('__default__', { id: null, username: state.account.username, pinterestUserId: state.account.pinterestUserId, needsReconnect: !!state.account.needsReconnect, isDefault: true });
  }
  try {
    const res = await d.listPins({ limit: 100, accountId: null });
    if (res && res.ok && res.data && res.data.pins) {
      const ids = [...new Set(res.data.pins.map((p) => p.accountId).filter(Boolean))];
      for (const id of ids) {
        // The default account also appears in pins — same Pinterest user id
        // means the same account, not a second one.
        const acc = await d.getAccount(id);
        if (acc && acc.ok && acc.data && acc.data.username) {
          if (acc.data.pinterestUserId && state.account && acc.data.pinterestUserId === state.account.pinterestUserId) continue;
          found.set(id, { id, username: acc.data.username, pinterestUserId: acc.data.pinterestUserId, needsReconnect: !!acc.data.needsReconnect, isDefault: false });
        }
      }
    }
  } catch (_e) { /* discovery is best-effort */ }
  state.accounts = [...found.values()];
}

async function loadAllForDashboard() {
  await loadAccount();
  await Promise.all([loadBoards(), discoverAccounts()]);
}

// ---------------------------------------------------------------------------
// Sidebar account chip
// ---------------------------------------------------------------------------
function updateAccountChip() {
  const chip = $('account-chip');
  if (!state.account || !state.account.connected) {
    chip.classList.add('hidden');
    return;
  }
  chip.classList.remove('hidden');
  const name = state.account.username || 'Pinterest';
  $('account-avatar').textContent = (name[0] || '?').toUpperCase();
  $('account-name').textContent = '@' + name;
  $('account-sub').textContent = state.account.needsReconnect
    ? 'Reconnect needed — sign in on the website'
    : `${fmtNum(state.account.boardCount)} boards`;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
async function renderDashboard() {
  const host = $('dashboard-content');
  if (!state.account) {
    host.innerHTML = '<div class="loading">Loading your account…</div>';
    await loadAllForDashboard();
    if (!state.account) {
      host.innerHTML = '<div class="empty"><h3>Could not load your account</h3><p>Check the connection and try Refresh.</p></div>';
      return;
    }
  }
  // Fresh counts for the stat cards.
  const [pinsRes, schedRes, pubRes, queueRes, analyticsRes] = await Promise.all([
    d.listPins({ limit: 1, accountId: activeAccountId() }),
    d.listPins({ limit: 1, status: 'SCHEDULED', accountId: activeAccountId() }),
    d.listPins({ limit: 1, status: 'PUBLISHED', accountId: activeAccountId() }),
    d.getQueue(activeAccountId()),
    d.getAnalytics(activeAccountId()),
  ]);
  const totalPins = pinsRes && pinsRes.ok ? pinsRes.data.total : 0;
  const schedPins = schedRes && schedRes.ok ? schedRes.data.total : 0;
  const pubPins = pubRes && pubRes.ok ? pubRes.data.total : 0;
  const queueTotal = queueRes && queueRes.ok ? queueRes.data.total : 0;
  const totals = analyticsRes && analyticsRes.ok ? analyticsRes.data.totals : null;
  const analyticsNote = analyticsRes && analyticsRes.ok && !analyticsRes.data.connected
    ? 'No Pinterest account connected — connect one on the website to see analytics.'
    : 'Pinterest reports lag a day or two, so today can still read low.';

  const recentRes = await d.listPins({ limit: 6, accountId: activeAccountId() });
  const recent = recentRes && recentRes.ok ? recentRes.data.pins : [];

  host.innerHTML = `
    ${state.account.needsReconnect ? '<div class="alert alert-error">Your Pinterest connection needs attention — sign in again on 365pinterest.com to reconnect it.</div>' : ''}
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">Boards</div><div class="stat-value">${fmtNum(state.account.boardCount)}</div><div class="stat-sub">on @${esc(state.account.username || '')}</div></div>
      <div class="stat-card"><div class="stat-label">Pins saved</div><div class="stat-value">${fmtNum(totalPins)}</div><div class="stat-sub">drafts, scheduled and published</div></div>
      <div class="stat-card"><div class="stat-label">Scheduled</div><div class="stat-value">${fmtNum(schedPins)}</div><div class="stat-sub">${fmtNum(queueTotal)} in the queue</div></div>
      <div class="stat-card"><div class="stat-label">Published</div><div class="stat-value">${fmtNum(pubPins)}</div><div class="stat-sub">via 365 Pinterest</div></div>
    </div>
    <div class="grid-2">
      <div class="card">
        <h3>Last 30 days</h3>
        ${totals ? `
        <div class="stat-grid mb-0">
          <div><div class="stat-label">Impressions</div><div class="stat-value stat-value-sm">${fmtNum(totals.impressions)}</div></div>
          <div><div class="stat-label">Pin clicks</div><div class="stat-value stat-value-sm">${fmtNum(totals.clicks)}</div></div>
          <div><div class="stat-label">Saves</div><div class="stat-value stat-value-sm">${fmtNum(totals.saves)}</div></div>
          <div><div class="stat-label">Outbound clicks</div><div class="stat-value stat-value-sm">${fmtNum(totals.outboundClicks)}</div></div>
        </div>` : '<p class="muted">Analytics could not be loaded.</p>'}
        <p class="fineprint">${esc(analyticsNote)}</p>
        <p class="mt-12"><button class="btn btn-ghost" data-goto="analytics">Open full analytics →</button></p>
      </div>
      <div class="card">
        <h3>Recent pins</h3>
        ${recent.length === 0
          ? '<p class="muted">No pins yet. Create your first pin and it will show up here.</p>'
          : `<div class="queue-list">${recent.map((p) => `
            <div class="queue-item">
              ${p.imageUrl ? `<img class="queue-thumb" src="${esc(p.imageUrl)}" alt="" loading="lazy">` : '<div class="queue-thumb"></div>'}
              <div><div class="strong">${esc(p.title)}</div><div class="pin-meta">${esc(statusLabel(p.status))} · ${esc(fmtDateShort(p.scheduledFor || p.publishedAt || p.createdAt))}</div></div>
              <span class="badge badge-${esc(p.status)}">${esc(p.status)}</span>
            </div>`).join('')}</div>`}
        <p class="mt-12"><button class="btn btn-ghost" data-goto="pins">View all pins →</button></p>
      </div>
    </div>`;
}

function statusLabel(s) {
  return { DRAFT: 'Draft', SCHEDULED: 'Scheduled', PUBLISHED: 'Published', FAILED: 'Failed', POSTING: 'Publishing' }[s] || s;
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------
const BOARD_COLORS = ['#E60023', '#7C3AED', '#0E7490', '#B45309', '#15803D', '#BE185D', '#1D4ED8', '#6D28D9'];
function boardColorIndex(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % BOARD_COLORS.length;
}

function fillBoardSelects() {
  const pinSelect = $('pin-board');
  const filter = $('pins-board-filter');
  const options = state.boards.map((b) => `<option value="${esc(b.id)}">${esc(b.name)} (${fmtNum(b.pinCount)})</option>`).join('');
  pinSelect.innerHTML = '<option value="">Choose a board…</option>' + options;
  filter.innerHTML = '<option value="">All boards</option>' + options;
  if (state.pinBoardFilter) filter.value = state.pinBoardFilter;
}

async function renderBoards() {
  const host = $('boards-content');
  if (!state.boardsLoaded) {
    host.innerHTML = '<div class="loading">Loading boards…</div>';
    await loadBoards();
  }
  $('boards-subtitle').textContent = state.boards.length === 0
    ? 'Your Pinterest boards.'
    : `${state.boards.length} board${state.boards.length === 1 ? '' : 's'} on @${state.account ? state.account.username : ''}.`;
  if (state.boards.length === 0) {
    host.innerHTML = `<div class="empty"><h3>No boards found</h3><p>Your Pinterest boards will appear here once the account is connected.<br>If you just connected Pinterest on the website, press Refresh.</p><button class="btn btn-primary" id="empty-new-board">${ic('plus-sign')} New board</button></div>`;
    $('empty-new-board').addEventListener('click', openBoardModal);
    return;
  }
  host.innerHTML = `<div class="board-grid">${state.boards.map((b) => `
    <button class="board-card" data-board-id="${esc(b.id)}">
      <div class="board-cover bc-${boardColorIndex(b.id)}">${esc((b.name || '?')[0].toUpperCase())}</div>
      <div class="board-name">${esc(b.name)}</div>
      <div class="board-meta">${fmtNum(b.pinCount)} pins · ${esc(b.privacy || 'PUBLIC')}</div>
      ${b.description ? `<div class="board-desc">${esc(b.description)}</div>` : ''}
    </button>`).join('')}</div>`;
  host.querySelectorAll('.board-card').forEach((card) => {
    card.addEventListener('click', () => {
      state.pinBoardFilter = card.dataset.boardId;
      state.pinStatusFilter = '';
      showScreen('pins');
    });
  });
}

function openBoardModal() {
  $('board-name').value = '';
  $('board-description').value = '';
  $('board-privacy').value = 'PUBLIC';
  $('board-error').classList.add('hidden');
  $('modal-board').classList.remove('hidden');
  $('board-name').focus();
}
function closeBoardModal() { $('modal-board').classList.add('hidden'); }

async function submitBoard() {
  const name = $('board-name').value.trim();
  if (!name) {
    const e = $('board-error');
    e.textContent = 'Give the board a name.';
    e.classList.remove('hidden');
    return;
  }
  const btn = $('board-create-btn');
  btn.disabled = true;
  const res = await d.createBoard({
    name,
    description: $('board-description').value.trim() || undefined,
    privacy: $('board-privacy').value,
    accountId: activeAccountId(),
  });
  btn.disabled = false;
  if (!res || !res.ok) {
    const e = $('board-error');
    e.textContent = (res && res.error) || 'Could not create the board.';
    e.classList.remove('hidden');
    return;
  }
  closeBoardModal();
  state.boardsLoaded = false;
  showToast('Board created.');
  renderBoards();
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------
function filteredPins() {
  const q = state.pinSearch.trim().toLowerCase();
  return state.pins.filter((p) => !q || (p.title || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q));
}

function pinCardHtml(p) {
  const board = state.boards.find((b) => b.id === p.boardId);
  return `
  <div class="pin-card">
    ${p.imageUrl ? `<img class="pin-thumb" src="${esc(p.imageUrl)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'pin-thumb-fallback\\'>Image unavailable</div>'">` : '<div class="pin-thumb-fallback">No image</div>'}
    <div class="pin-body">
      <div><span class="badge badge-${esc(p.status)}">${esc(p.status)}</span></div>
      <div class="pin-title">${esc(p.title)}</div>
      <div class="pin-meta">${board ? esc(board.name) : 'Board'} · ${esc(fmtDateShort(p.scheduledFor || p.publishedAt || p.createdAt))}</div>
      ${p.status === 'SCHEDULED' && p.scheduledFor ? `<div class="pin-meta">Publishes ${esc(timeUntil(p.scheduledFor))}</div>` : ''}
      ${p.error ? `<div class="pin-meta text-red">Error: ${esc(p.error)}</div>` : ''}
      <div class="pin-actions">
        ${p.status === 'DRAFT' || p.status === 'FAILED' ? `<button class="btn btn-sm btn-secondary" data-act="schedule" data-id="${esc(p.id)}" data-title="${esc(p.title)}">Schedule</button>` : ''}
        ${p.status === 'SCHEDULED' ? `<button class="btn btn-sm btn-secondary" data-act="schedule" data-id="${esc(p.id)}" data-title="${esc(p.title)}">Reschedule</button><button class="btn btn-sm btn-ghost" data-act="cancel" data-id="${esc(p.id)}">Cancel</button>` : ''}
        ${p.pinterestUrl ? `<button class="btn btn-sm btn-ghost" data-open-external="${esc(p.pinterestUrl)}">View on Pinterest</button>` : ''}
      </div>
    </div>
  </div>`;
}

async function renderPins() {
  const host = $('pins-content');
  host.innerHTML = '<div class="loading">Loading pins…</div>';
  const res = await handleResult(await d.listPins({
    status: state.pinStatusFilter || undefined,
    boardId: state.pinBoardFilter || undefined,
    limit: 100,
    accountId: activeAccountId(),
  }));
  if (!res) {
    host.innerHTML = '<div class="empty"><h3>Pins could not be loaded</h3><p>Check the connection and try Refresh.</p></div>';
    return;
  }
  state.pins = res.pins || [];
  state.pinsTotal = res.total || 0;
  const list = filteredPins();
  document.querySelectorAll('#status-chips .chip').forEach((c) => c.classList.toggle('active', c.dataset.status === state.pinStatusFilter));
  if (list.length === 0) {
    host.innerHTML = `<div class="empty"><h3>No pins here yet</h3><p>${state.pins.length === 0 ? 'Create your first pin — it takes a minute.' : 'Nothing matches these filters.'}</p><button class="btn btn-primary" data-goto="create">${ic('plus-sign')} New pin</button></div>`;
  } else {
    host.innerHTML = `<p class="muted mb-12">Showing ${list.length} of ${fmtNum(state.pinsTotal)} pins.</p><div class="pin-grid">${list.map(pinCardHtml).join('')}</div>`;
  }
  host.querySelectorAll('[data-act="schedule"]').forEach((btn) => {
    btn.addEventListener('click', () => openScheduleModal(btn.dataset.id, btn.dataset.title));
  });
  host.querySelectorAll('[data-act="cancel"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const r = await d.cancelPin(btn.dataset.id);
      if (r && r.ok) { showToast('Pin moved back to drafts.'); renderPins(); }
      else showGlobalError((r && r.error) || 'Could not cancel the pin.');
    });
  });
}

// ---------------------------------------------------------------------------
// Create pin
// ---------------------------------------------------------------------------
function renderCreate() {
  if (!state.boardsLoaded) loadBoards();
  else fillBoardSelects();
}

function setCreateImage(file) {
  state.createImage = file;
  if (!file) {
    $('image-preview').classList.add('hidden');
    $('image-preview-empty').classList.remove('hidden');
    $('image-file-info').classList.add('hidden');
    $('clear-image-btn').classList.add('hidden');
    return;
  }
  $('image-preview').src = file.dataUrl;
  $('image-preview').classList.remove('hidden');
  $('image-preview-empty').classList.add('hidden');
  const info = $('image-file-info');
  info.textContent = `${file.name} — ${(file.size / 1024 / 1024).toFixed(2)} MB`;
  info.classList.remove('hidden');
  $('clear-image-btn').classList.remove('hidden');
  $('pin-image-url').value = '';
}

async function pickImage() {
  const picked = await d.pickImage();
  if (!picked) return;
  if (picked.size > 10 * 1024 * 1024) {
    const e = $('create-error');
    e.textContent = 'That file is too large (10 MB maximum).';
    e.classList.remove('hidden');
    return;
  }
  setCreateImage(picked);
}

function localToIso(localValue) {
  if (!localValue) return null;
  const dt = new Date(localValue);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

async function submitCreate(event) {
  event.preventDefault();
  const errEl = $('create-error');
  errEl.classList.add('hidden');
  const title = $('pin-title').value.trim();
  const boardId = $('pin-board').value;
  const imageUrl = $('pin-image-url').value.trim();
  const scheduledLocal = $('pin-scheduled').value;
  let scheduledFor = null;
  if (scheduledLocal) {
    scheduledFor = localToIso(scheduledLocal);
    if (!scheduledFor || new Date(scheduledFor).getTime() <= Date.now()) {
      errEl.textContent = 'Schedule for a time in the future.';
      errEl.classList.remove('hidden');
      return;
    }
  }
  if (!title) { errEl.textContent = 'Add a title for the pin.'; errEl.classList.remove('hidden'); return; }
  if (!boardId) { errEl.textContent = 'Choose a board.'; errEl.classList.remove('hidden'); return; }
  if (!state.createImage && !imageUrl) {
    errEl.textContent = 'Add an image — pick a file or paste an image URL.';
    errEl.classList.remove('hidden');
    return;
  }
  if (!state.createImage && imageUrl) {
    let u = null;
    try { u = new URL(imageUrl); } catch (_e) { u = null; }
    const okExt = u && ['.jpg', '.jpeg', '.png', '.webp'].some((ext) => u.pathname.toLowerCase().endsWith(ext));
    if (!u || u.protocol !== 'https:' || !okExt) {
      errEl.textContent = 'The image URL must be an https link ending in .jpg, .jpeg, .png or .webp.';
      errEl.classList.remove('hidden');
      return;
    }
  }
  const btn = $('create-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const fields = {
    title,
    description: $('pin-description').value.trim() || undefined,
    destinationUrl: $('pin-destination').value.trim() || undefined,
    boardId,
    imageUrl: state.createImage ? undefined : imageUrl,
    scheduledFor: scheduledFor || undefined,
    accountId: activeAccountId(),
  };
  const res = await d.createPin({ fields, imagePath: state.createImage ? state.createImage.path : null });
  btn.disabled = false;
  btn.textContent = 'Save pin';
  if (!res || !res.ok) {
    errEl.textContent = (res && res.error) || 'Could not save the pin.';
    errEl.classList.remove('hidden');
    if (res && res.upgradeUrl) showGlobalError(res.error, res.upgradeUrl);
    return;
  }
  const pin = res.data.pin;
  showToast(pin.status === 'SCHEDULED' ? `Scheduled for ${fmtDate(pin.scheduledFor)}.` : 'Draft saved.');
  // Reset the form.
  $('create-form').reset();
  setCreateImage(null);
  $('title-count').textContent = '0';
  $('desc-count').textContent = '0';
  state.pinStatusFilter = pin.status === 'SCHEDULED' ? 'SCHEDULED' : '';
  showScreen('pins');
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
async function renderQueue() {
  const host = $('queue-content');
  host.innerHTML = '<div class="loading">Loading the queue…</div>';
  const data = await handleResult(await d.getQueue(activeAccountId()));
  if (!data) {
    host.innerHTML = '<div class="empty"><h3>Queue could not be loaded</h3><p>Check the connection and try Refresh.</p></div>';
    return;
  }
  state.queue = data.queue || [];
  if (state.queue.length === 0) {
    host.innerHTML = '<div class="empty"><h3>Nothing scheduled</h3><p>Schedule a pin and it will appear here in publish order.<br>Scheduled pins are published automatically by the server.</p><button class="btn btn-primary" data-goto="create">' + ic('plus-sign') + ' New pin</button></div>';
    return;
  }
  host.innerHTML = `<p class="muted mb-12">${state.queue.length} pin${state.queue.length === 1 ? '' : 's'} waiting to publish.</p>
  <div class="queue-list">${state.queue.map((p) => `
    <div class="queue-item">
      ${p.imageUrl ? `<img class="queue-thumb" src="${esc(p.imageUrl)}" alt="" loading="lazy">` : '<div class="queue-thumb"></div>'}
      <div>
        <div class="strong">${esc(p.title)}</div>
        <div class="pin-meta">${esc(p.boardName || '')}</div>
      </div>
      <div class="queue-when">
        <div class="when-main">${esc(fmtDate(p.scheduledFor))}</div>
        <div class="when-sub">${esc(timeUntil(p.scheduledFor))}</div>
      </div>
      <button class="btn btn-sm btn-ghost" data-act="cancel" data-id="${esc(p.id)}">Cancel</button>
      <button class="btn btn-sm btn-secondary" data-act="schedule" data-id="${esc(p.id)}" data-title="${esc(p.title)}">Reschedule</button>
    </div>`).join('')}</div>`;
  host.querySelectorAll('[data-act="cancel"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const r = await d.cancelPin(btn.dataset.id);
      if (r && r.ok) { showToast('Pin moved back to drafts.'); renderQueue(); }
      else showGlobalError((r && r.error) || 'Could not cancel the pin.');
    });
  });
  host.querySelectorAll('[data-act="schedule"]').forEach((btn) => {
    btn.addEventListener('click', () => openScheduleModal(btn.dataset.id, btn.dataset.title));
  });
}

// ---------------------------------------------------------------------------
// Schedule modal
// ---------------------------------------------------------------------------
let schedulePinId = null;
function openScheduleModal(pinId, title) {
  schedulePinId = pinId;
  $('schedule-pin-title').textContent = title || '';
  $('schedule-datetime').value = '';
  $('schedule-error').classList.add('hidden');
  $('modal-schedule').classList.remove('hidden');
  $('schedule-datetime').focus();
}
function closeScheduleModal() { $('modal-schedule').classList.add('hidden'); schedulePinId = null; }

async function submitSchedule() {
  const local = $('schedule-datetime').value;
  const iso = localToIso(local);
  if (!iso || new Date(iso).getTime() <= Date.now()) {
    const e = $('schedule-error');
    e.textContent = 'Pick a time in the future.';
    e.classList.remove('hidden');
    return;
  }
  const btn = $('schedule-save-btn');
  btn.disabled = true;
  const res = await d.schedulePin(schedulePinId, iso);
  btn.disabled = false;
  if (!res || !res.ok) {
    const e = $('schedule-error');
    e.textContent = (res && res.error) || 'Could not schedule the pin.';
    e.classList.remove('hidden');
    return;
  }
  closeScheduleModal();
  showToast(`Scheduled for ${fmtDate(res.data.pin.scheduledFor)}.`);
  if (state.screen === 'queue') renderQueue();
  else renderPins();
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------
async function renderAnalytics() {
  const host = $('analytics-content');
  host.innerHTML = '<div class="loading">Loading analytics…</div>';
  const data = await handleResult(await d.getAnalytics(activeAccountId()));
  if (!data) {
    host.innerHTML = '<div class="empty"><h3>Analytics could not be loaded</h3><p>Check the connection and try Refresh.</p></div>';
    return;
  }
  $('analytics-subtitle').textContent = data.connected
    ? `Last 30 days · ${fmtDateShort(data.startDate)} – ${fmtDateShort(data.endDate)} · from Pinterest`
    : 'Last 30 days, from Pinterest.';
  if (!data.connected) {
    host.innerHTML = '<div class="empty"><h3>No Pinterest account connected</h3><p>Connect a Pinterest account on 365pinterest.com first — analytics appear here once it is linked.</p></div>';
    return;
  }
  const t = data.totals;
  const allZero = !t.impressions && !t.clicks && !t.saves && !t.outboundClicks;
  host.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">Impressions</div><div class="stat-value">${fmtNum(t.impressions)}</div><div class="stat-sub">times pins were seen</div></div>
      <div class="stat-card"><div class="stat-label">Pin clicks</div><div class="stat-value">${fmtNum(t.clicks)}</div><div class="stat-sub">clicks on pins</div></div>
      <div class="stat-card"><div class="stat-label">Saves</div><div class="stat-value">${fmtNum(t.saves)}</div><div class="stat-sub">pins saved by others</div></div>
      <div class="stat-card"><div class="stat-label">Outbound clicks</div><div class="stat-value">${fmtNum(t.outboundClicks)}</div><div class="stat-sub">clicks through to your links</div></div>
    </div>
    <div class="card">
      <h3>About these numbers</h3>
      <p class="muted">These are the real totals Pinterest reports for the last 30 days — nothing is estimated or filled in. Pinterest data lags a day or two, so a new account or a quiet week can honestly read zero.</p>
      ${allZero ? '<p class="muted mt-8">All zeros right now. If your pins are already published, give Pinterest a day or two to report them.</p>' : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function renderSettings() {
  const host = $('settings-content');
  const info = await d.getInfo();
  const accounts = state.accounts;
  const selected = activeAccountId();
  host.innerHTML = `
  <div class="settings-list">
    <div class="card">
      <h3>Connection</h3>
      <div class="settings-row">
        <div>
          <div><strong>Signed in as</strong> — ${state.user && state.user.email ? esc(state.user.name ? `${state.user.name} (${state.user.email})` : state.user.email) : 'API key (email not recorded)'}</div>
          <div class="kv">Signed in with the same account as the website.</div>
        </div>
      </div>
      <div class="settings-row mt-12">
        <div>
          <div><strong>API key</strong> — ${state.hasKey ? 'saved' : 'not set'}</div>
          <div class="kv">Stored ${info.keyMethod === 'safeStorage' ? 'encrypted (system keychain)' : info.keyMethod === 'safeStorage-plaintext' ? 'with basic encryption on this computer' : 'on this computer'} · never leaves the app except to 365pinterest.com</div>
        </div>
        <button class="btn btn-secondary" id="settings-change-key">Change key</button>
      </div>
      <div class="settings-row mt-12">
        <div>
          <div><strong>Sign out</strong></div>
          <div class="kv">Revokes the app's API key and removes the saved sign-in from this computer. Your pins and boards stay on your account.</div>
        </div>
        <button class="btn btn-danger" id="settings-signout">Sign out</button>
      </div>
    </div>
    <div class="card">
      <h3>Pinterest accounts</h3>
      <p class="muted">The app uses your newest connected account by default. Other accounts are found from the pins already saved under them.</p>
      <div class="account-list">
        ${accounts.length === 0 ? '<p class="muted">No accounts discovered yet — open the Dashboard first.</p>' : accounts.map((a) => `
          <button class="account-row ${(!selected && a.isDefault) || selected === a.id ? 'selected' : ''}" data-account-id="${a.id || ''}">
            <div class="account-avatar">${esc((a.username || '?')[0].toUpperCase())}</div>
            <div><div class="strong">@${esc(a.username || 'unknown')}</div><div class="kv">${a.isDefault ? 'Default account' : 'Account ID ' + esc(a.id)}${a.needsReconnect ? ' · reconnect needed' : ''}</div></div>
          </button>`).join('')}
      </div>
      <p class="fineprint">An account with no pins yet will not appear here. To use one, connect it on the website, save a pin under it, and refresh.</p>
    </div>
    <div class="card">
      <h3>Appearance</h3>
      <div class="settings-row">
        <div><strong>Theme</strong><div class="kv">Light or dark — Ctrl+D toggles it any time.</div></div>
        <button class="btn btn-secondary" id="settings-theme">${state.settings.theme === 'dark' ? 'Switch to light' : 'Switch to dark'}</button>
      </div>
    </div>
    <div class="card">
      <h3>About</h3>
      <div class="kv">365 Pinterest <strong>${esc(info.version)}</strong> · ${esc(info.platform)} · © ${new Date().getFullYear()} Anjum Labs</div>
      <div class="kv mt-6">Desktop client for <button class="linklike" data-open-external="https://365pinterest.com">365pinterest.com</button> — <button class="linklike" data-open-external="https://365pinterest.com/developers">API documentation</button></div>
      <div class="mt-12"><button class="btn btn-secondary" id="settings-check-updates">Check for updates</button> <button class="btn btn-secondary hidden" id="settings-download-update">${ic('download-01')} Download update</button> <button class="btn btn-primary hidden" id="settings-restart-update">Restart to install</button></div>
      <div class="kv mt-6" id="settings-update-status"></div>
    </div>
  </div>`;

  $('settings-change-key').addEventListener('click', () => showScreen('setup'));
  $('settings-signout').addEventListener('click', async () => {
    await d.signOut();
    state.hasKey = false;
    state.user = null;
    state.account = null;
    state.accounts = [];
    state.boards = [];
    state.boardsLoaded = false;
    state.settings.accountId = null;
    await d.setSettings({ accountId: null });
    updateAccountChip();
    showToast('Signed out.');
    showScreen('setup');
  });
  $('settings-theme').addEventListener('click', toggleTheme);
  $('settings-check-updates').addEventListener('click', async () => {
    $('settings-update-status').textContent = 'Checking for updates…';
    await d.checkForUpdates();
  });
  $('settings-download-update').addEventListener('click', async () => { await d.downloadUpdate(); });
  $('settings-restart-update').addEventListener('click', async () => { await d.installUpdate(); });
  renderUpdateUI();
  host.querySelectorAll('.account-row').forEach((row) => {
    row.addEventListener('click', async () => {
      const id = row.dataset.accountId || null;
      state.settings.accountId = id;
      await d.setSettings({ accountId: id });
      state.account = null;
      state.boardsLoaded = false;
      showToast(id ? 'Switched Pinterest account.' : 'Using the default Pinterest account.');
      renderSettings();
      await loadAccount();
    });
  });
}

// ---------------------------------------------------------------------------
// Auto-update (v2.1.0) — visible status in Settings + a banner
// ---------------------------------------------------------------------------
function updateStatusText() {
  const s = state.update;
  const v = state.version || '';
  if (s.status === 'checking') return `You're on v${v} — checking for updates…`;
  if (s.status === 'available') return `You're on v${v} — update v${s.version} is available.`;
  if (s.status === 'downloading') return `You're on v${v} — downloading v${s.version}… ${s.progress}%`;
  if (s.status === 'downloaded') return `You're on v${v} — v${s.version} downloaded. Restart to install it.`;
  if (s.status === 'error') return `You're on v${v} — update check failed${s.error ? ': ' + s.error : '.'}`;
  if (s.status === 'up-to-date') return `You're on v${v} — you're up to date${s.lastCheckedAt ? ' (checked ' + fmtDate(s.lastCheckedAt) + ')' : ''}.`;
  return `You're on v${v}.`;
}

function renderUpdateUI() {
  const s = state.update;
  const statusEl = $('settings-update-status');
  if (statusEl) statusEl.textContent = updateStatusText();
  const settingsDl = $('settings-download-update');
  const settingsRestart = $('settings-restart-update');
  if (settingsDl) settingsDl.classList.toggle('hidden', s.status !== 'available');
  if (settingsRestart) settingsRestart.classList.toggle('hidden', s.status !== 'downloaded');
  const banner = $('update-banner');
  const textEl = $('update-banner-text');
  const dlBtn = $('update-download-btn');
  const restartBtn = $('update-restart-btn');
  if (s.status === 'available' || s.status === 'downloading' || s.status === 'downloaded') {
    if (state.updateBannerDismissedFor === s.version) { banner.classList.add('hidden'); return; }
    banner.classList.remove('hidden');
    if (s.status === 'available') {
      textEl.textContent = `Update v${s.version} is available — you're on v${state.version}.`;
      dlBtn.classList.remove('hidden');
      restartBtn.classList.add('hidden');
    } else if (s.status === 'downloading') {
      textEl.textContent = `Downloading v${s.version}… ${s.progress}%`;
      dlBtn.classList.add('hidden');
      restartBtn.classList.add('hidden');
    } else {
      textEl.textContent = `Update v${s.version} downloaded — restart to install it.`;
      dlBtn.classList.add('hidden');
      restartBtn.classList.remove('hidden');
    }
  } else {
    banner.classList.add('hidden');
  }
}

function handleUpdateEvent(payload) {
  if (payload.type === 'update-state' && payload.state) {
    state.update = { ...state.update, ...payload.state };
  } else if (payload.type === 'update-available') {
    state.update = { ...state.update, status: 'available', version: payload.version, progress: 0 };
  } else if (payload.type === 'update-progress') {
    state.update = { ...state.update, status: 'downloading', progress: payload.percent || 0 };
  } else if (payload.type === 'update-downloaded') {
    state.update = { ...state.update, status: 'downloaded', version: payload.version, progress: 100 };
  } else if (payload.type === 'update-not-available') {
    state.update = { ...state.update, status: 'up-to-date', lastCheckedAt: new Date().toISOString() };
  } else if (payload.type === 'update-error') {
    state.update = { ...state.update, status: 'error', error: payload.message || 'Update check failed.' };
  } else {
    return;
  }
  renderUpdateUI();
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.settings.theme);
  $('theme-toggle').innerHTML = ic(state.settings.theme === 'dark' ? 'sun-02' : 'moon-02');
}
async function toggleTheme() {
  state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
  await d.setSettings({ theme: state.settings.theme });
  applyTheme();
}

// ---------------------------------------------------------------------------
// Setup — same sign-in as the website (v2.1.0)
// ---------------------------------------------------------------------------
// Email + password: the password is only sent to 365pinterest.com inside
// the sign-in request — it is never stored or logged. On success the main
// process mints a desktop API key from the session, so the app then works
// exactly like the paste-key flow.
async function submitEmailSignIn(event) {
  event.preventDefault();
  const errEl = $('setup-error');
  const verifyEl = $('verify-box');
  errEl.classList.add('hidden');
  verifyEl.classList.add('hidden');
  const email = $('signin-email').value.trim();
  const password = $('signin-password').value;
  if (!email || !password) { errEl.textContent = 'Enter your email and password.'; errEl.classList.remove('hidden'); return; }
  const btn = $('signin-btn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  const res = await d.signInEmail(email, password);
  btn.disabled = false;
  btn.textContent = 'Sign in';
  if (!res || !res.ok) {
    if (res && res.needsVerification) {
      verifyEl.textContent = res.error;
      verifyEl.classList.remove('hidden');
    } else {
      errEl.textContent = (res && res.error) || 'Could not sign in.';
      errEl.classList.remove('hidden');
    }
    return;
  }
  state.user = res.user || null;
  state.hasKey = true;
  state.account = null;
  state.boardsLoaded = false;
  $('signin-password').value = '';
  showToast(state.user && state.user.name ? `Signed in as ${state.user.name}.` : 'Signed in.');
  await loadAllForDashboard();
  showScreen('dashboard');
}

// "Continue with Pinterest" — in-window OAuth (proven in v1). Closing the
// window is a quiet cancel, not an error.
async function submitPinterestSignIn() {
  const errEl = $('setup-error');
  errEl.classList.add('hidden');
  const btn = $('pinterest-btn');
  btn.disabled = true;
  const res = await d.signInPinterest();
  btn.disabled = false;
  if (!res || !res.ok) {
    if (res && res.error === 'cancelled') return;
    errEl.textContent = (res && res.error) || 'Pinterest sign-in failed.';
    errEl.classList.remove('hidden');
    return;
  }
  state.user = res.user || null;
  state.hasKey = true;
  state.account = null;
  state.boardsLoaded = false;
  showToast('Signed in with Pinterest.');
  await loadAllForDashboard();
  showScreen('dashboard');
}

async function submitSetup() {
  const key = $('api-key-input').value.trim();
  const errEl = $('setup-error');
  errEl.classList.add('hidden');
  if (!key) { errEl.textContent = 'Paste your API key first.'; errEl.classList.remove('hidden'); return; }
  const btn = $('validate-key-btn');
  btn.disabled = true;
  btn.textContent = 'Validating…';
  const res = await d.validateKey(key);
  btn.disabled = false;
  btn.textContent = 'Validate & connect';
  if (!res || !res.ok) {
    errEl.textContent = (res && res.error) || 'Could not validate the key.';
    errEl.classList.remove('hidden');
    return;
  }
  state.user = null; // paste-key flow: no identity recorded
  state.hasKey = true;
  state.account = res.data;
  state.boardsLoaded = false;
  $('api-key-input').value = '';
  updateAccountChip();
  showToast(res.data.connected ? `Connected as @${res.data.username}.` : 'Key saved — no Pinterest account connected yet.');
  await loadAllForDashboard();
  showScreen('dashboard');
}

// ---------------------------------------------------------------------------
// Refresh current screen
// ---------------------------------------------------------------------------
async function refreshCurrent() {
  showGlobalError(null);
  if (state.screen === 'dashboard') { state.account = null; await renderDashboard(); }
  else if (state.screen === 'boards') { state.boardsLoaded = false; renderBoards(); }
  else if (state.screen === 'pins') renderPins();
  else if (state.screen === 'queue') renderQueue();
  else if (state.screen === 'analytics') renderAnalytics();
  else if (state.screen === 'settings') renderSettings();
  else if (state.screen === 'create') renderCreate();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wireEvents() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => go(btn.dataset.screen));
  });
  document.querySelectorAll('[data-open-external]').forEach((el) => {
    el.addEventListener('click', () => d.openExternal(el.dataset.openExternal));
  });
  document.addEventListener('click', (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) go(goto.dataset.goto);
    const ext = e.target.closest('[data-open-external]');
    if (ext && !ext.dataset.bound) d.openExternal(ext.dataset.openExternal);
  });
  $('new-pin-btn').addEventListener('click', () => go('create'));
  $('refresh-btn').addEventListener('click', refreshCurrent);
  $('theme-toggle').addEventListener('click', toggleTheme);
  $('signin-form').addEventListener('submit', submitEmailSignIn);
  $('pinterest-btn').addEventListener('click', submitPinterestSignIn);
  $('update-download-btn').addEventListener('click', async () => { await d.downloadUpdate(); });
  $('update-restart-btn').addEventListener('click', async () => { await d.installUpdate(); });
  $('update-dismiss-btn').addEventListener('click', () => {
    state.updateBannerDismissedFor = state.update.version;
    $('update-banner').classList.add('hidden');
  });
  $('toggle-key-visibility').addEventListener('click', () => {
    const input = $('api-key-input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('toggle-key-visibility').textContent = show ? 'Hide' : 'Show';
  });
  $('validate-key-btn').addEventListener('click', submitSetup);
  $('api-key-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitSetup(); });

  // Pins filters
  document.querySelectorAll('#status-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.pinStatusFilter = chip.dataset.status;
      renderPins();
    });
  });
  $('pins-board-filter').addEventListener('change', (e) => {
    state.pinBoardFilter = e.target.value;
    renderPins();
  });
  $('pins-search').addEventListener('input', (e) => {
    state.pinSearch = e.target.value;
    renderPins();
  });

  // Create form
  $('pin-title').addEventListener('input', (e) => { $('title-count').textContent = e.target.value.length; });
  $('pin-description').addEventListener('input', (e) => { $('desc-count').textContent = e.target.value.length; });
  $('pick-image-btn').addEventListener('click', pickImage);
  $('image-drop').addEventListener('click', (e) => { if (e.target.id === 'image-drop' || e.target.closest('#image-preview-empty')) pickImage(); });
  $('clear-image-btn').addEventListener('click', () => setCreateImage(null));
  $('pin-image-url').addEventListener('input', (e) => { if (e.target.value.trim() && state.createImage) setCreateImage(null); });
  $('create-form').addEventListener('submit', submitCreate);
  $('create-reset-btn').addEventListener('click', () => { $('create-form').reset(); setCreateImage(null); $('title-count').textContent = '0'; $('desc-count').textContent = '0'; });

  // Board modal
  $('new-board-btn').addEventListener('click', openBoardModal);
  $('board-cancel-btn').addEventListener('click', closeBoardModal);
  $('board-create-btn').addEventListener('click', submitBoard);
  $('modal-board').addEventListener('click', (e) => { if (e.target.id === 'modal-board') closeBoardModal(); });

  // Schedule modal
  $('schedule-cancel-btn').addEventListener('click', closeScheduleModal);
  $('schedule-save-btn').addEventListener('click', submitSchedule);
  $('modal-schedule').addEventListener('click', (e) => { if (e.target.id === 'modal-schedule') closeScheduleModal(); });

  // Menu / shortcut events from main
  d.onNav((screen) => go(screen));
  d.onRefresh(() => refreshCurrent());
  d.onToggleTheme(() => toggleTheme());
  d.onUpdateEvent(handleUpdateEvent);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  wireEvents();
  hydrateIcons();
  const info = await d.getInfo();
  state.version = info.version || '';
  $('version-label').textContent = `365 Pinterest v${state.version}`;
  state.settings = { theme: 'light', accountId: null, ...(await d.getSettings()) };
  applyTheme();
  state.hasKey = await d.hasKey();
  state.user = await d.getUser();
  const us = await d.getUpdateState();
  if (us) {
    state.update = {
      status: us.status || 'idle',
      version: us.version || null,
      progress: us.progress || 0,
      error: us.error || null,
      lastCheckedAt: us.lastCheckedAt || null,
    };
  }
  renderUpdateUI();
  const hash = (location.hash || '').replace('#/', '');
  const start = ['dashboard', 'boards', 'pins', 'create', 'queue', 'analytics', 'settings'].includes(hash) ? hash : 'dashboard';
  if (!state.hasKey) {
    showScreen('setup');
    return;
  }
  await loadAllForDashboard();
  if (!state.account) {
    showScreen('setup');
    return;
  }
  showScreen(start);
}

document.addEventListener('DOMContentLoaded', boot);
