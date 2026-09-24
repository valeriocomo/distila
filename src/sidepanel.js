const summarizeBtn = document.getElementById('summarizeBtn');
const copyBtn = document.getElementById('copyBtn');
const statusEl = document.getElementById('status');
const warningEl = document.getElementById('warning');
const outputEl = document.getElementById('output');
const typeSelect = document.getElementById('typeSelect');
const lengthSelect = document.getElementById('lengthSelect');
const formatSelect = document.getElementById('formatSelect');

// The panel is only a view: the summarization runs in the offscreen document
// (see offscreen.js) so it survives the panel closing and tab switches. The
// panel follows the active tab of its window and renders that tab's job from
// chrome.storage.session, re-syncing whenever the tab, its page or the stored
// jobs change. On browsers without the side panel API the same page is the
// action popup (sidepanel.html?mode=popup, set by background.js).
const IS_POPUP = new URLSearchParams(location.search).get('mode') === 'popup';
document.body.classList.toggle('popup', IS_POPUP);

const ACCESS_HINT = 'Click the Distila icon in the toolbar (or in the Extensions menu) to use Distila on this page.';
const RESTRICTED_MSG = "Distila can't summarize this page.";
const FILE_ACCESS_MSG = 'To summarize local files, turn on "Allow access to file URLs" for Distila in chrome://extensions.';
const BUSY_MSG = 'Distila is busy with another page: it summarizes one page at a time. Try again when it is done.';
const BUSY_ELSEWHERE_MSG = 'Distila is summarizing another page...';
const ERROR_PAGE_MSG = "This page didn't load. Reload it and try again.";
const COPY_LABEL = 'Copy summary';

const jobKey = (tabId) => `job:${tabId}`;

// Page identity for matching a stored job to the tab: the #fragment is
// ignored (in-page anchors must not hide the summary) unless it looks like a
// hash-router path (#/... or #!...), where it names a different page.
function pageKey(url) {
  const hash = url.indexOf('#');
  if (hash === -1) return url;
  const fragment = url.slice(hash + 1);
  return fragment.startsWith('/') || fragment.startsWith('!') ? url : url.slice(0, hash);
}

function samePage(a, b) {
  return !!a && !!b && pageKey(a) === pageKey(b);
}

// What the panel shows: the active tab of this window and its job.
const view = { windowId: null, tabId: null, url: null, job: null, busyElsewhere: false };
// Tabs with a click in flight (extraction and hand-off), and the per-tab
// outcome of the last click when it didn't start a job (busy, extraction
// errors) — neither is part of any stored job. Busy notices are dropped as
// soon as a job ends (see storage.onChanged).
const starting = new Set();
const notices = new Map(); // tabId -> { url, text, busy }
let refreshSeq = 0;
let copyTimer = null;

const ready = chrome.windows.getCurrent().then((win) => {
  view.windowId = win.id;
});

// Only touch the DOM on actual changes: #status is an aria-live region, and
// rewriting the same text would make screen readers announce it again.
function setStatus(msg) {
  if (statusEl.textContent !== msg) statusEl.textContent = msg;
}

function setWarning(msg) {
  msg = msg || '';
  if (warningEl.textContent !== msg) warningEl.textContent = msg;
  warningEl.style.display = msg ? 'block' : 'none';
}

// Persist the filter selections (chrome.storage.sync) so they survive the
// panel closing and are shared by the panels of all windows.
const filterSelects = { type: typeSelect, length: lengthSelect, format: formatSelect };

function saveFilters() {
  chrome.storage.sync.set({
    filters: {
      type: typeSelect.value,
      length: lengthSelect.value,
      format: formatSelect.value,
    },
  });
}

async function restoreFilters() {
  const { filters } = await chrome.storage.sync.get('filters');
  if (!filters) return;
  for (const [key, select] of Object.entries(filterSelects)) {
    const value = filters[key];
    // Only apply values that still match an existing option
    if (value && select.querySelector(`option[value="${value}"]`)) {
      select.value = value;
    }
  }
}

for (const select of Object.values(filterSelects)) {
  select.addEventListener('change', saveFilters);
}

/**
 * Function executed IN the page context (via chrome.scripting.executeScript).
 * Tries to isolate the article text, otherwise falls back to the whole body.
 */
function extractArticleText() {
  function textOf(el) {
    return el ? el.innerText.trim() : '';
  }

  // 1. Semantic <article> tag
  let el = document.querySelector('article');
  let text = textOf(el);

  // 2. Common containers for articles/blogs
  if (text.length < 200) {
    const selectors = ['main', '[role="main"]', '.post-content', '.article-content', '#content', '.entry-content'];
    for (const sel of selectors) {
      const candidate = document.querySelector(sel);
      const candidateText = textOf(candidate);
      if (candidateText.length > text.length) {
        text = candidateText;
      }
    }
  }

  // 3. Fallback: the entire body
  if (text.length < 200) {
    text = textOf(document.body);
  }

  return text;
}

/**
 * Re-reads the active tab and the stored jobs, then renders. Tab events can
 * arrive in bursts, so an older refresh that resolves late is discarded.
 */
async function refresh() {
  const seq = ++refreshSeq;
  await ready;
  const [[tab], stored] = await Promise.all([
    chrome.tabs.query({ active: true, windowId: view.windowId }),
    chrome.storage.session.get(null),
  ]);
  if (seq !== refreshSeq) return;

  view.tabId = tab?.id ?? null;
  // Without the "tabs" permission the url is only exposed while activeTab is
  // granted on the tab: no url means Distila can't read this page (yet).
  view.url = tab?.url || null;
  // A job for a page the tab navigated away from stays stored but hidden (it
  // shows up again on Back) until it is replaced or the tab is closed.
  const job = view.tabId != null ? stored[jobKey(view.tabId)] : undefined;
  view.job = job && samePage(job.url, view.url) ? job : null;
  view.busyElsewhere = Object.entries(stored).some(
    ([key, j]) => key.startsWith('job:') && j?.status === 'running' && j !== view.job,
  );
  render();
}

function render() {
  const { tabId, url, job } = view;
  const notice = notices.get(tabId);
  const isStarting = starting.has(tabId);

  // Start from a blank view: the panel outlives tab switches, so nothing of
  // the previous tab may leak into this one.
  let output = '';
  let status = '';
  let canStart = true;

  if (!url) {
    status = ACCESS_HINT;
    canStart = false;
  } else if (!/^(https?|file):/.test(url)) {
    status = RESTRICTED_MSG;
    canStart = false;
  } else if (isStarting) {
    status = 'Extracting text from the page...';
    canStart = false;
  } else if (job?.status === 'running') {
    status = job.progress || 'Summarizing...';
    canStart = false;
  } else {
    if (job?.status === 'done') {
      output = job.summary;
      status = 'Done.';
    } else if (job?.status === 'error') {
      status = `Error: ${job.message}`;
    } else if (view.busyElsewhere) {
      status = BUSY_ELSEWHERE_MSG;
    }
    // The last click on this page didn't start a job (it left the stored
    // state as it was): its outcome wins over that state.
    if (notice && samePage(notice.url, url)) status = notice.text;
  }

  // The unsupported-language warning rides on the job through both the
  // running and done states, so it survives panel reopens mid-job.
  setWarning(job && job.status !== 'error' && !isStarting ? job.warning : null);
  // Rewriting identical text would drop the user's selection in the summary
  if (outputEl.textContent !== output) outputEl.textContent = output;
  copyBtn.style.display = output ? 'block' : 'none';
  summarizeBtn.disabled = !canStart;
  setStatus(status);
}

/**
 * Turns an extraction failure into a message the user can act on. Checking
 * the tab again tells a lost activeTab grant (fixed by clicking the icon)
 * apart from pages no extension may script (the icon can't fix those).
 */
async function describeScriptError(err, tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return 'The tab was closed.';
  }
  if (!tab.url) return ACCESS_HINT;
  if (tab.url.startsWith('file:') && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    return FILE_ACCESS_MSG;
  }
  const message = err?.message || String(err);
  if (/showing error page/i.test(message)) return ERROR_PAGE_MSG;
  if (/Cannot access|cannot be scripted/i.test(message)) return RESTRICTED_MSG;
  return `Error: ${message}`;
}

chrome.tabs.onActivated.addListener(({ windowId }) => {
  if (windowId === view.windowId) refresh();
});

// status covers navigations even when the url itself is hidden (no access).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === view.tabId && (changeInfo.url || changeInfo.status)) refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.filters) {
    restoreFilters();
  }
  if (area !== 'session') return;

  let relevant = false;
  for (const [key, { oldValue, newValue }] of Object.entries(changes)) {
    if (!key.startsWith('job:')) continue;
    const wasRunning = oldValue?.status === 'running';
    const isRunning = newValue?.status === 'running';
    // A job ended (or its tab closed): earlier "busy" replies are outdated.
    if (wasRunning && !isRunning) {
      for (const [tabId, notice] of notices) {
        if (notice.busy) notices.delete(tabId);
      }
    }
    // Progress ticks of other tabs' jobs don't change this view: only this
    // tab's job and jobs starting or ending (the busy hint) do.
    if (key === jobKey(view.tabId) || wasRunning !== isRunning) relevant = true;
  }
  if (relevant) refresh();
});

// The toolbar icon was clicked in this window, which grants activeTab on its
// active tab: re-check. No reply, the service worker doesn't wait for one.
chrome.runtime.onMessage.addListener((message) => {
  if (
    message?.target === 'sidepanel' &&
    message.action === 'tab-access-granted' &&
    message.windowId === view.windowId
  ) {
    refresh();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

restoreFilters();
refresh();

summarizeBtn.addEventListener('click', async () => {
  // Pin the tab at click time: the user may switch tabs while the text is
  // extracted, and the job must stay bound to the page it was started on.
  const { tabId } = view;
  if (tabId == null) return;
  let url = view.url;
  const notify = (text, busy = false) => notices.set(tabId, { url, text, busy });

  notices.delete(tabId);
  starting.add(tabId);
  render();

  try {
    if (!('Summarizer' in self)) {
      notify('The Summarizer API is not available in this browser (requires Chrome 138+).');
      return;
    }

    let articleText;
    try {
      url = (await chrome.tabs.get(tabId)).url;
      if (!url) return; // access lost meanwhile: refresh() shows the hint
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractArticleText,
      });
      articleText = injection?.result;
    } catch (err) {
      notify(await describeScriptError(err, tabId));
      return;
    }

    if (!articleText || articleText.trim().length < 50) {
      notify('Could not find enough text on the page.');
      return;
    }

    // Hand the job off to the offscreen document (via the service worker) and
    // just reflect its state: the pipeline keeps running if the panel closes.
    // The reply arrives once the job's running state is stored.
    const response = await chrome.runtime.sendMessage({
      target: 'background',
      action: 'start-summarization',
      payload: {
        articleText,
        type: typeSelect.value,
        length: lengthSelect.value,
        format: formatSelect.value,
        url,
        tabId,
      },
    });

    if (response?.busy) {
      notify(BUSY_MSG, true);
    } else if (!response?.ok) {
      notify(`Error: ${response?.error || 'could not start the summarization.'}`);
    }
  } catch (err) {
    console.error(err);
    notify(`Error: ${err.message || err}`);
  } finally {
    starting.delete(tabId);
    await refresh();
  }
});

copyBtn.addEventListener('click', async () => {
  // Copy the stored summary of the page on screen, not whatever the DOM holds
  const summary = view.job?.summary;
  if (!summary) return;
  try {
    await navigator.clipboard.writeText(summary);
    // One pending reset at a time: the panel is long-lived, so a label left
    // at 'Copied' by overlapping clicks would stick for every later summary.
    clearTimeout(copyTimer);
    copyBtn.textContent = 'Copied ✔';
    copyTimer = setTimeout(() => (copyBtn.textContent = COPY_LABEL), 1500);
  } catch (err) {
    setStatus(`Unable to copy: ${err.message || err}`);
  }
});
