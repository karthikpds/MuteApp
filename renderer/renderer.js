'use strict';

/* global window, document */
/**
 * AppMute renderer — vanilla JS UI.
 * Talks to main only through window.appMute (preload bridge).
 * Hotkey display formatting mirrors lib/hotkey-utils.js.
 */

const api = window.appMute;

let state = { apps: [], settings: {}, platform: '', capabilities: {}, autostart: false };
let processCache = [];
let selectedProcess = null;
let hotkeyTargetId = null;
let capturedAccelerator = '';
let noticeDismissed = false; // per-session dismissal of the platform notice

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- display ---

function formatHotkey(acc) {
  if (!acc) return 'Not set';
  const isMac = state.platform === 'macos';
  return acc
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((tok) => {
      const l = tok.toLowerCase();
      if (l === 'commandorcontrol') return isMac ? '⌘' : 'Ctrl';
      if (l === 'ctrl' || l === 'control') return isMac ? '⌃' : 'Ctrl';
      if (l === 'alt' || l === 'option') return isMac ? '⌥' : 'Alt';
      if (l === 'shift') return isMac ? '⇧' : 'Shift';
      if (l === 'super' || l === 'meta' || l === 'cmd' || l === 'command') return isMac ? '⌘' : 'Win';
      return tok.length === 1 ? tok.toUpperCase() : tok;
    })
    .join(' + ');
}

function statusPills(a) {
  const pills = [];
  if (a.running === false) {
    pills.push('<span class="pill offline">Not running</span>');
  } else if (a.paused) {
    pills.push('<span class="pill paused">⏸ Paused</span>');
  } else if (a.muted) {
    pills.push(`<span class="pill muted">🔇 Muted${a.emulated ? ' (emulated)' : ''}</span>`);
  } else {
    pills.push('<span class="pill unmuted">🔊 Unmuted</span>');
  }
  const sup = a.support || {};
  if (state.capabilities && state.capabilities.perAppMute === false && sup.muteSupported === false) {
    pills.push('<span class="pill">Limited on macOS</span>');
  } else if (sup.muteEmulated) {
    pills.push('<span class="pill emulated">App volume</span>');
  }
  return pills.join('');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------- render ---

function render() {
  document.documentElement.dataset.theme = (state.settings && state.settings.theme) || 'dark';

  const badge = $('platform-badge');
  if (state.capabilities && state.capabilities.perAppMute) {
    badge.textContent = state.platform === 'windows' ? 'Windows · true per-app mute' : 'Full per-app mute';
    badge.className = 'platform-badge full';
    badge.title = state.capabilities.notes || '';
  } else {
    badge.textContent = state.platform === 'macos' ? 'macOS · limited' : 'Limited support';
    badge.className = 'platform-badge limited';
    badge.title = (state.capabilities && state.capabilities.notes) || '';
  }

  const notice = $('platform-notice');
  const noticeText = $('platform-notice-text');
  if (!noticeDismissed && state.platform === 'macos') {
    notice.classList.remove('hidden');
    noticeText.innerHTML =
      '<strong>macOS limitation:</strong> macOS provides no system API for muting a single app. ' +
      'AppMute can control in-app volume for scriptable apps (e.g. Spotify) and pause/resume media apps. ' +
      'Browsers, Discord and similar apps are marked <em>Limited</em> — mute inside the app or use a virtual-audio driver.';
  } else if (!noticeDismissed && state.platform === 'windows' && window.__audioHelperMissing) {
    notice.classList.remove('hidden');
    noticeText.textContent =
      'Windows audio helper (AudioController.exe) is missing — build native/windows first. See native/windows/README.md.';
  } else {
    notice.classList.add('hidden');
    noticeText.textContent = '';
  }

  const list = $('app-list');
  list.innerHTML = '';
  $('empty-state').classList.toggle('hidden', state.apps.length > 0);

  for (const a of state.apps) {
    const card = document.createElement('div');
    card.className = 'app-card' + (a.muted ? ' is-muted' : '');
    const initial = escapeHtml((a.name || '?').trim().charAt(0).toUpperCase());
    const sup = a.support || {};
    const muteSupported = sup.muteSupported !== false;
    const pauseSupported = !!sup.pauseSupported;

    card.innerHTML = `
      <div class="app-icon" data-icon-for="${escapeHtml(a.id)}">${initial}</div>
      <div class="app-main">
        <div class="app-name">${escapeHtml(a.name)}</div>
        <div class="app-proc">${escapeHtml(a.processName || '')}${a.pid ? ` · PID ${a.pid}` : ''}</div>
        <div class="app-sub">
          ${statusPills(a)}
          <button class="hotkey-chip ${a.hotkey ? '' : 'unset'}" data-action="hotkey" title="Set hotkey (global)">${
            a.hotkey ? escapeHtml(formatHotkey(a.hotkey)) : 'Set hotkey'
          }</button>
        </div>
      </div>
      <label class="switch" title="${muteSupported ? 'Mute / unmute' : escapeHtml(sup.muteReason || 'Muting not supported')}">
        <input type="checkbox" data-action="toggle" ${a.muted ? 'checked' : ''} ${muteSupported ? '' : 'disabled'} />
        <span class="slider"></span>
      </label>
      <div class="kebab-wrap">
        <button class="kebab" data-action="menu" aria-label="More options">⋮</button>
        <div class="menu hidden" role="menu"></div>
      </div>`;

    // Async icon enrichment (best effort).
    if (a.exePath) {
      api.getFileIcon(a.exePath).then((res) => {
        if (res && res.ok && res.data && res.data.dataUrl) {
          const slot = card.querySelector(`[data-icon-for="${CSS.escape(a.id)}"]`);
          if (slot) slot.innerHTML = `<img alt="" src="${res.data.dataUrl}" />`;
        }
      }).catch(() => {});
    }

    card.querySelector('[data-action="toggle"]').addEventListener('change', (e) => {
      void setMuted(a.id, e.target.checked);
    });
    card.querySelector('[data-action="hotkey"]').addEventListener('click', () => openHotkeyDialog(a.id));
    const kebab = card.querySelector('[data-action="menu"]');
    const menu = card.querySelector('.menu');
    kebab.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.menu').forEach((m) => { if (m !== menu) m.classList.add('hidden'); });
      buildMenu(menu, a, muteSupported, pauseSupported, sup);
      menu.classList.toggle('hidden');
    });

    list.appendChild(card);
  }

  document.addEventListener('click', () => {
    document.querySelectorAll('.menu').forEach((m) => m.classList.add('hidden'));
  }, { once: true });

  const n = state.apps.length;
  const mutedCount = state.apps.filter((a) => a.muted).length;
  $('statusbar-text').textContent =
    n === 0 ? 'Add an app to get started.' : `${n} app${n === 1 ? '' : 's'} · ${mutedCount} muted`;
}

function buildMenu(menu, a, muteSupported, pauseSupported, sup) {
  menu.innerHTML = '';
  const addItem = (label, fn, opts = {}) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (opts.danger) b.classList.add('danger');
    if (opts.disabled) b.disabled = true;
    if (opts.title) b.title = opts.title;
    b.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.add('hidden'); fn(); });
    menu.appendChild(b);
    return b;
  };
  const note = (text) => {
    const d = document.createElement('div');
    d.className = 'menu-note';
    d.textContent = text;
    menu.appendChild(d);
  };

  addItem(a.muted ? 'Unmute' : 'Mute', () => setMuted(a.id, !a.muted),
    muteSupported ? {} : { disabled: true, title: sup.muteReason });
  if (!muteSupported && sup.muteReason) note(sup.muteReason);

  addItem('Set Hotkey…', () => openHotkeyDialog(a.id));

  if (pauseSupported) {
    addItem(a.paused ? 'Resume' : 'Pause', () => togglePause(a));
  } else {
    addItem('Pause / Resume', () => {}, {
      disabled: true,
      title: (sup && sup.pauseReason) || 'This application does not expose compatible media controls.',
    });
    note('Pause unavailable: app exposes no compatible media controls.');
  }

  addItem('Open Application', () => openApp(a.id));
  addItem('Remove', () => removeApp(a.id), { danger: true });
}

// ---------------------------------------------------------------- actions ---

async function refresh() {
  try {
    const res = await api.getState();
    if (!res.ok) {
      toast('error', 'Could not load state', res.error);
      return;
    }
    state = { ...state, ...res.data };
    if (res.data.capabilities && res.data.capabilities.perAppMute === false && state.platform === 'windows') {
      // Windows without helper still reports capability true; detect via error text instead.
    }
    render();
  } catch (e) {
    toast('error', 'Could not load state', String((e && e.message) || e));
  }
}

function unwrap(res, fallbackMsg) {
  if (res && res.ok) return res.data;
  const msg = (res && res.error) || fallbackMsg || 'Something went wrong.';
  if (/audio helper not found/i.test(msg)) window.__audioHelperMissing = true;
  toast('error', 'AppMute', msg);
  render();
  return null;
}

async function setMuted(id, muted) {
  const res = unwrap(await api.setMuted(id, muted));
  if (res) await refresh();
}

async function togglePause(a) {
  const res = unwrap(await (a.paused ? api.resume(a.id) : api.pause(a.id)));
  if (res) await refresh();
}

async function openApp(id) {
  const res = await api.openApp(id);
  if (!res.ok) toast('error', 'Could not open application', res.error);
}

async function removeApp(id) {
  const target = state.apps.find((a) => a.id === id);
  if (!target) return;
  if (!window.confirm(`Remove "${target.name}" from AppMute?`)) return;
  const res = unwrap(await api.removeApp(id));
  if (res) await refresh();
}

// ---------------------------------------------------------------- Add App ---

function openAddDialog() {
  $('modal-add').classList.remove('hidden');
  $('add-search').value = '';
  selectedProcess = null;
  $('add-confirm').disabled = true;
  $('add-hint').classList.add('hidden');
  $('add-hint').textContent = '';
  $('add-list').innerHTML = '<p class="muted">Loading running applications…</p>';
  api.listProcesses().then((res) => {
    if (!res.ok) {
      $('add-list').innerHTML = `<p class="muted">Could not list applications: ${escapeHtml(res.error)}</p>`;
      return;
    }
    // Main returns { apps, tabDenials } (array form tolerated for safety).
    const payload = res.data || {};
    processCache = Array.isArray(payload) ? payload : payload.apps || [];
    const denials = Array.isArray(payload) ? [] : payload.tabDenials || [];
    if (denials.length > 0) {
      const hint = $('add-hint');
      hint.textContent = denials[0]; // how to enable tab titles; shown once, inline
      hint.classList.remove('hidden');
    }
    renderProcessList('');
  }).catch((e) => {
    $('add-list').innerHTML = `<p class="muted">Could not list applications: ${escapeHtml(String((e && e.message) || e))}</p>`;
  });
  setTimeout(() => $('add-search').focus(), 50);
}

function closeAddDialog() {
  $('modal-add').classList.add('hidden');
}

/** Search matches names, tab titles/URLs, and window titles — not just processes. */
function processMatches(p, q) {
  if (!q) return true;
  if ((p.name || '').toLowerCase().includes(q)) return true;
  if ((p.processName || '').toLowerCase().includes(q)) return true;
  if ((p.activeTabTitle || '').toLowerCase().includes(q)) return true;
  if ((p.windowTitles || []).some((t) => t.toLowerCase().includes(q))) return true;
  if ((p.tabs || []).some((t) => (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q))) return true;
  return false;
}

/** Second line of a picker row: tab/window identification, then process identity. */
function processSubtitle(p) {
  const bits = [];
  if (p.activeTabTitle) {
    bits.push(`▶ ${p.activeTabTitle}`);
    if (p.totalTabs > 1) bits.push(`${p.totalTabs} tabs`);
  } else if (p.windowTitles && p.windowTitles.length) {
    bits.push(`🪟 ${p.windowTitles[0]}`);
    if (p.windowTitles.length > 1) bits.push(`+${p.windowTitles.length - 1} more`);
  }
  bits.push(p.processName || p.name || '');
  if (p.grouped && p.processCount > 1) bits.push(`${p.processCount} processes`);
  else if (p.pid) bits.push(`PID ${p.pid}`);
  return bits.filter(Boolean).join(' · ');
}

function renderProcessList(filter) {
  const q = filter.trim().toLowerCase();
  const tracked = new Set(state.apps.map((a) => a.name.toLowerCase()));
  const items = processCache.filter((p) => processMatches(p, q)).slice(0, 200);
  const box = $('add-list');
  box.innerHTML = '';
  if (items.length === 0) {
    box.innerHTML = '<p class="muted">No matching applications.</p>';
    return;
  }
  for (const p of items) {
    const el = document.createElement('div');
    el.className = 'pick-item' + (selectedProcess === p ? ' selected' : '');
    const already = tracked.has((p.name || '').toLowerCase());
    el.innerHTML = `
      <div class="pick-avatar">${escapeHtml((p.name || '?').charAt(0).toUpperCase())}</div>
      <div><div class="pick-name">${escapeHtml(p.name)}${already ? ' (added)' : ''}</div>
      <div class="pick-sub">${escapeHtml(processSubtitle(p))}</div></div>`;
    el.addEventListener('click', () => {
      selectedProcess = p;
      $('add-confirm').disabled = !!already;
      box.querySelectorAll('.pick-item').forEach((n) => n.classList.remove('selected'));
      el.classList.add('selected');
    });
    el.addEventListener('dblclick', () => {
      if (!already) void confirmAdd();
    });
    box.appendChild(el);
  }
}

async function confirmAdd() {
  if (!selectedProcess) return;
  const res = await api.addApp(selectedProcess);
  if (!res.ok) {
    toast('error', 'Could not add application', res.error);
    return;
  }
  closeAddDialog();
  toast('info', `Added "${selectedProcess.name}"`, 'Assign it a hotkey to mute it globally.');
  await refresh();
}

// -------------------------------------------------------------- Hotkey dlg ---

/** Build an Electron accelerator from a keydown event (literal modifiers). */
function acceleratorFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super'); // Command on macOS, Windows key on Windows
  const key = e.key;
  if (!key) return '';
  const lower = key.toLowerCase();
  if (['control', 'alt', 'shift', 'meta', 'os'].includes(lower)) return ''; // modifier-only
  const order = { Control: 0, Alt: 1, Shift: 2, Super: 3 };
  mods.sort((a, b) => order[a] - order[b]);
  let finalKey = key.length === 1 ? key.toUpperCase() : key;
  // Normalize common names to Electron accelerator tokens.
  const named = { ' ': 'Space', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', escape: 'Esc' };
  if (named[lower]) finalKey = named[lower];
  if (mods.length === 0) return '';
  return [...mods, finalKey].join('+');
}

function openHotkeyDialog(id) {
  hotkeyTargetId = id;
  capturedAccelerator = '';
  const target = state.apps.find((a) => a.id === id);
  $('hotkey-app-name').textContent = target ? `Application: ${target.name}` : '';
  $('hotkey-capture').textContent = target && target.hotkey ? formatHotkey(target.hotkey) : 'Press keys…';
  $('hotkey-capture').classList.toggle('captured', !!(target && target.hotkey));
  if (target && target.hotkey) capturedAccelerator = target.hotkey;
  $('hotkey-conflict').classList.add('hidden');
  $('hotkey-save').disabled = true;
  $('modal-hotkey').classList.remove('hidden');
  updateHotkeyDialog();
  setTimeout(() => $('hotkey-capture').focus(), 50);
}

function closeHotkeyDialog() {
  $('modal-hotkey').classList.add('hidden');
  hotkeyTargetId = null;
}

function updateHotkeyDialog() {
  const conflictBox = $('hotkey-conflict');
  if (!capturedAccelerator) {
    conflictBox.classList.add('hidden');
    $('hotkey-save').disabled = true;
    return;
  }
  const dupe = state.apps.find(
    (a) => a.id !== hotkeyTargetId && (a.hotkey || '').toLowerCase() === capturedAccelerator.toLowerCase()
  );
  if (dupe) {
    conflictBox.textContent = `⚠ Already assigned to "${dupe.name}". Choose a different combination.`;
    conflictBox.classList.remove('hidden');
    $('hotkey-save').disabled = true;
  } else {
    conflictBox.classList.add('hidden');
    $('hotkey-save').disabled = false;
  }
}

async function saveHotkey() {
  if (!hotkeyTargetId || !capturedAccelerator) return;
  const res = await api.setHotkey(hotkeyTargetId, capturedAccelerator);
  if (!res.ok) {
    const box = $('hotkey-conflict');
    box.textContent = res.error;
    box.classList.remove('hidden');
    return;
  }
  closeHotkeyDialog();
  toast('info', 'Hotkey saved', formatHotkey(capturedAccelerator));
  await refresh();
}

// ---------------------------------------------------------------- Settings ---

function openSettings() {
  const s = state.settings || {};
  $('set-startup').checked = !!s.launchAtStartup;
  $('set-minimized').checked = !!s.startMinimized;
  $('set-notify').checked = s.showNotifications !== false;
  $('set-tray').checked = s.minimizeToTrayOnClose !== false;
  $('set-theme').value = s.theme || 'dark';
  $('settings-note').textContent =
    `Platform: ${state.platform || 'unknown'} · ` +
    (state.autostart ? 'Launching at startup is ON.' : 'Launching at startup is OFF.');
  $('modal-settings').classList.remove('hidden');
}

function closeSettings() {
  $('modal-settings').classList.add('hidden');
}

async function patchSettings(patch) {
  const res = await api.updateSettings(patch);
  if (!res.ok) {
    toast('error', 'Could not save settings', res.error);
    await refresh();
    return;
  }
  state.settings = res.data.settings;
  state.autostart = res.data.autostart;
  render();
  openSettingsRefreshOnly();
}

function openSettingsRefreshOnly() {
  const s = state.settings || {};
  $('set-startup').checked = !!s.launchAtStartup;
  $('set-minimized').checked = !!s.startMinimized;
  $('set-notify').checked = s.showNotifications !== false;
  $('set-tray').checked = s.minimizeToTrayOnClose !== false;
  $('set-theme').value = s.theme || 'dark';
  $('settings-note').textContent =
    `Platform: ${state.platform || 'unknown'} · ` +
    (state.autostart ? 'Launching at startup is ON.' : 'Launching at startup is OFF.');
}

// ----------------------------------------------------------------- toasts ---

function toast(type, title, body = '') {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.innerHTML = `<strong>${escapeHtml(title)}</strong>${body ? `<span>${escapeHtml(body)}</span>` : ''}`;
  box.appendChild(el);
  while (box.children.length > 4) box.removeChild(box.firstChild);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 320);
  }, type === 'error' ? 7000 : 3500);
}

// ------------------------------------------------------------------ events ---

function bindEvents() {
  $('btn-add').addEventListener('click', openAddDialog);
  $('notice-dismiss').addEventListener('click', () => {
    noticeDismissed = true;
    $('platform-notice').classList.add('hidden');
  });
  $('add-cancel').addEventListener('click', closeAddDialog);
  $('add-confirm').addEventListener('click', () => void confirmAdd());
  $('add-search').addEventListener('input', (e) => renderProcessList(e.target.value));
  $('modal-add').addEventListener('click', (e) => { if (e.target.id === 'modal-add') closeAddDialog(); });

  $('hotkey-cancel').addEventListener('click', closeHotkeyDialog);
  $('hotkey-save').addEventListener('click', () => void saveHotkey());
  $('hotkey-clear').addEventListener('click', async () => {
    if (!hotkeyTargetId) return;
    const res = await api.setHotkey(hotkeyTargetId, '');
    if (!res.ok) {
      toast('error', 'Could not remove hotkey', res.error);
      return;
    }
    closeHotkeyDialog();
    await refresh();
  });
  $('modal-hotkey').addEventListener('click', (e) => { if (e.target.id === 'modal-hotkey') closeHotkeyDialog(); });
  $('hotkey-capture').addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      closeHotkeyDialog();
      return;
    }
    if (e.key === 'Backspace') {
      capturedAccelerator = '';
      $('hotkey-capture').textContent = 'Press keys…';
      $('hotkey-capture').classList.remove('captured');
      updateHotkeyDialog();
      return;
    }
    const acc = acceleratorFromEvent(e);
    if (!acc) return;
    capturedAccelerator = acc;
    $('hotkey-capture').textContent = formatHotkey(acc);
    $('hotkey-capture').classList.add('captured');
    updateHotkeyDialog();
  });

  $('btn-settings').addEventListener('click', openSettings);
  $('set-close').addEventListener('click', closeSettings);
  $('modal-settings').addEventListener('click', (e) => { if (e.target.id === 'modal-settings') closeSettings(); });
  $('set-startup').addEventListener('change', (e) => void patchSettings({ launchAtStartup: e.target.checked }));
  $('set-minimized').addEventListener('change', (e) => void patchSettings({ startMinimized: e.target.checked }));
  $('set-notify').addEventListener('change', (e) => void patchSettings({ showNotifications: e.target.checked }));
  $('set-tray').addEventListener('change', (e) => void patchSettings({ minimizeToTrayOnClose: e.target.checked }));
  $('set-theme').addEventListener('change', (e) => void patchSettings({ theme: e.target.value }));
  $('set-reset').addEventListener('click', async () => {
    if (!window.confirm('Reset all settings to defaults? (Your app list is kept.)')) return;
    const res = await api.resetSettings();
    if (!res.ok) {
      toast('error', 'Could not reset settings', res.error);
      return;
    }
    state.settings = res.data.settings;
    render();
    openSettingsRefreshOnly();
  });

  $('btn-refresh').addEventListener('click', () => void refresh());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAddDialog();
      closeHotkeyDialog();
      closeSettings();
    }
  });

  api.onAppsUpdated((apps) => {
    state.apps = apps;
    render();
  });
  api.onToast((t) => toast(t.type, t.title, t.body));

  // Keep statuses fresh (detect relaunch / closed apps) without hammering the OS.
  setInterval(() => void refresh(), 15000);
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  void refresh();
});
