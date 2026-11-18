const summarizeBtn = document.getElementById('summarizeBtn');
const cancelBtn = document.getElementById('cancelBtn');
const copyBtn = document.getElementById('copyBtn');
const statusEl = document.getElementById('status');
const warningEl = document.getElementById('warning');
const outputEl = document.getElementById('output');
const typeSelect = document.getElementById('typeSelect');
const lengthSelect = document.getElementById('lengthSelect');
const formatSelect = document.getElementById('formatSelect');
const chatTab = document.getElementById('chatTab');
const summaryTab = document.getElementById('summaryTab');
const chatPanel = document.getElementById('chatPanel');
const summaryPanel = document.getElementById('summaryPanel');
const chatStatusEl = document.getElementById('chatStatus');
const chatWarningEl = document.getElementById('chatWarning');
const chatLog = document.getElementById('chatLog');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const askBtn = document.getElementById('askBtn');
const stopBtn = document.getElementById('stopBtn');
const resetBtn = document.getElementById('resetBtn');

// The panel is only a view: the summarization runs in the offscreen document
// (see offscreen.js), which queues jobs and survives the panel closing and
// tab switches. The panel follows the active tab of its window and renders
// that tab's job and chat from chrome.storage.session, re-syncing whenever
// the tab, its page or the stored state change. The chat sessions live in the
// offscreen document too: the panel sends questions and renders the stored
// transcript. jobKey/chatKey/samePage/isActiveJob/isActiveChat come from
// common.js. On browsers without the side panel API the same page is the
// action popup (sidepanel.html?mode=popup, set by background.js).
const IS_POPUP = new URLSearchParams(location.search).get('mode') === 'popup';
document.body.classList.toggle('popup', IS_POPUP);

const ACCESS_HINT = 'Click the Distila icon in the toolbar (or in the Extensions menu) to use Distila on this page.';
const RESTRICTED_MSG = "Distila can't summarize this page.";
const FILE_ACCESS_MSG = 'To summarize local files, turn on "Allow access to file URLs" for Distila in chrome://extensions.';
const ERROR_PAGE_MSG = "This page didn't load. Reload it and try again.";
const COPY_LABEL = 'Copy summary';

const CHAT_BUSY_MSG = 'Distila is answering a chat question. Summaries are available when it finishes.';
const SUMMARY_BUSY_MSG = 'Distila is summarizing a page. The chat is available when it finishes.';
const CHAT_ELSEWHERE_MSG = 'Distila is answering a question on another page...';
const NO_PROMPT_API_MSG = 'The chat requires the Prompt API (Chrome 138+).';
const MODEL_UNAVAILABLE_MSG = "The chat model isn't available on this device.";
const MODEL_DOWNLOAD_MSG = 'Ask a question about this page. The language model downloads with the first question (it may take a while).';
const MODEL_DOWNLOADING_MSG = 'Ask a question about this page. The language model is downloading...';
const CHAT_EMPTY_MSG = 'Ask a question about this page.';
const TRIMMED_MSG = 'Older messages were dropped from the model\'s memory.';
const RESTARTED_MSG = 'Distila restarted: earlier messages are no longer in the model\'s memory.';

const queuedMsg = (position) => `Queued (#${position}): Distila is summarizing another page first.`;

// Hint for a tab without its own job while others are queued or running
function activeElsewhereMsg(count) {
  const waiting = count - 1;
  return `Distila is summarizing another page${waiting > 0 ? ` (${waiting} waiting)` : ''}...`;
}

// What the panel shows: the active tab of this window, its job and chat, how
// many other jobs are queued or running, and how many chats of other tabs are
// preparing or answering (chat and summaries never run at the same time).
const view = {
  windowId: null,
  tabId: null,
  url: null,
  job: null,
  activeElsewhere: 0,
  jobsActive: 0,
  chat: null,
  chatsElsewhere: 0,
};
// Tabs with a click in flight (extraction and hand-off, or a cancel), and the
// per-tab outcome of the last click when it changed no stored job
// (extraction errors, "Cancelled.") — none of them is part of a stored job.
const starting = new Set();
const cancelling = new Set();
const notices = new Map(); // tabId -> { url, text }
// Same, for the chat: a question being sent, a Stop in flight, the outcome of
// the last action that changed no stored chat, and per-tab unsent drafts (the
// textarea is shared by every tab the panel follows).
const chatStarting = new Set();
const chatCancelling = new Set();
const chatNotices = new Map(); // tabId -> { url, text }
const drafts = new Map(); // tabId -> text
let renderedChatId = null;
// LanguageModel.availability() for the panel's hints: 'checking', 'no-api',
// 'unavailable', 'downloadable', 'downloading' or 'available'.
let chatAvailability = 'checking';
let activePanel = 'chat';
let refreshSeq = 0;
let refreshesInFlight = 0;
let copyTimer = null;

const ready = chrome.windows.getCurrent().then((win) => {
  view.windowId = win.id;
});

// Only touch the DOM on actual changes: #status is an aria-live region, and
// rewriting the same text would make screen readers announce it again.
function setStatus(msg) {
  if (statusEl.textContent !== msg) statusEl.textContent = msg;
}

function setWarning(msg, el = warningEl) {
  msg = msg || '';
  if (el.textContent !== msg) el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function setChatStatus(msg) {
  if (chatStatusEl.textContent !== msg) chatStatusEl.textContent = msg;
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
  let tab, stored;
  refreshesInFlight++;
  try {
    await ready;
    [[tab], stored] = await Promise.all([
      chrome.tabs.query({ active: true, windowId: view.windowId }),
      chrome.storage.session.get(null),
    ]);
  } finally {
    refreshesInFlight--;
  }
  if (seq !== refreshSeq) return;

  const previousTabId = view.tabId;
  view.tabId = tab?.id ?? null;
  if (view.tabId !== previousTabId) swapDraft(previousTabId, view.tabId);
  // Without the "tabs" permission the url is only exposed while activeTab is
  // granted on the tab: no url means Distila can't read this page (yet).
  view.url = tab?.url || null;
  // A job for a page the tab navigated away from stays stored but hidden (it
  // shows up again on Back) until it is replaced or the tab is closed.
  const job = view.tabId != null ? stored[jobKey(view.tabId)] : undefined;
  view.job = job && samePage(job.url, view.url) ? job : null;
  // Includes this tab's own job for a page it navigated away from: it is
  // "another page" too.
  view.activeElsewhere = Object.entries(stored).filter(
    ([key, j]) => key.startsWith('job:') && isActiveJob(j) && j !== view.job,
  ).length;
  view.jobsActive = view.activeElsewhere + (isActiveJob(view.job) ? 1 : 0);
  // Like jobs, a chat of a page the tab left stays hidden (until the service
  // worker drops it).
  const chat = view.tabId != null ? stored[chatKey(view.tabId)] : undefined;
  view.chat = chat && samePage(chat.url, view.url) ? chat : null;
  view.chatsElsewhere = Object.entries(stored).filter(
    ([key, c]) => key.startsWith('chat:') && isActiveChat(c) && c !== view.chat,
  ).length;
  render();
}

// The question textarea follows the tab, like the rest of the view.
function swapDraft(fromTabId, toTabId) {
  if (fromTabId != null) {
    if (chatInput.value) drafts.set(fromTabId, chatInput.value);
    else drafts.delete(fromTabId);
  }
  chatInput.value = drafts.get(toTabId) ?? '';
}

function render() {
  renderTabs();
  renderSummary();
  renderChat();
}

function renderTabs() {
  for (const [tab, panel, name] of [[chatTab, chatPanel, 'chat'], [summaryTab, summaryPanel, 'summary']]) {
    const selected = activePanel === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  }
}

function renderSummary() {
  const { tabId, url, job } = view;
  const notice = notices.get(tabId);
  const isStarting = starting.has(tabId);

  // Start from a blank view: the panel outlives tab switches, so nothing of
  // the previous tab may leak into this one.
  let output = '';
  let status = '';
  let canStart = true;
  let canCancel = false;

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
    canCancel = true;
  } else if (job?.status === 'queued') {
    status = queuedMsg(job.position);
    canStart = false;
    canCancel = true;
  } else {
    if (job?.status === 'done') {
      output = job.summary;
      status = 'Done.';
    } else if (job?.status === 'error') {
      status = `Error: ${job.message}`;
    } else if (view.activeElsewhere) {
      status = activeElsewhereMsg(view.activeElsewhere);
    }
    // The model is busy with a chat answer: no new summary meanwhile
    if (view.chatsElsewhere || isActiveChat(view.chat)) {
      status = CHAT_BUSY_MSG;
      canStart = false;
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
  // Hiding the focused Cancel would drop keyboard focus to the page body
  if (!canCancel && document.activeElement === cancelBtn) summarizeBtn.focus();
  cancelBtn.style.display = canCancel ? 'block' : 'none';
  cancelBtn.disabled = cancelling.has(tabId);
  setStatus(status);
}

function renderChat() {
  const { tabId, url, chat } = view;
  const notice = chatNotices.get(tabId);
  const isStarting = chatStarting.has(tabId);
  const active = isActiveChat(chat);

  // Blank view first, as in renderSummary
  let status = '';
  let canAsk = true;
  let canStop = false;

  if (!url) {
    status = ACCESS_HINT;
    canAsk = false;
  } else if (!/^(https?|file):/.test(url)) {
    status = RESTRICTED_MSG;
    canAsk = false;
  } else if (chatAvailability === 'no-api') {
    status = NO_PROMPT_API_MSG;
    canAsk = false;
  } else if (chatAvailability === 'unavailable') {
    status = MODEL_UNAVAILABLE_MSG;
    canAsk = false;
  } else if (isStarting) {
    status = 'Reading the page...';
    canAsk = false;
  } else if (active) {
    status = chat.progress || (chat.status === 'preparing' ? 'Preparing the chat...' : 'Answering...');
    canAsk = false;
    canStop = true;
  } else if (view.jobsActive) {
    status = SUMMARY_BUSY_MSG;
    canAsk = false;
  } else if (view.chatsElsewhere) {
    status = CHAT_ELSEWHERE_MSG;
    canAsk = false;
  } else {
    if (chat?.error) status = `Error: ${chat.error}`;
    else if (chat?.restarted) status = RESTARTED_MSG;
    else if (chat?.trimmed) status = TRIMMED_MSG;
    else if (!chat?.messages?.length) {
      status = chatAvailability === 'downloadable' ? MODEL_DOWNLOAD_MSG
        : chatAvailability === 'downloading' ? MODEL_DOWNLOADING_MSG
        : CHAT_EMPTY_MSG;
    }
    // The last action on this page changed no stored chat: its outcome wins
    if (notice && samePage(notice.url, url)) status = notice.text;
  }

  setWarning(chat && !isStarting ? chat.warning : null, chatWarningEl);
  renderMessages(chat);
  askBtn.disabled = !canAsk;
  chatInput.disabled = !url || chatAvailability === 'no-api' || chatAvailability === 'unavailable';
  // Hiding the focused Stop would drop keyboard focus to the page body
  if (!canStop && document.activeElement === stopBtn) chatInput.focus();
  askBtn.style.display = canStop ? 'none' : 'block';
  stopBtn.style.display = canStop ? 'block' : 'none';
  stopBtn.disabled = chatCancelling.has(tabId);
  resetBtn.style.display = chat?.messages?.length ? 'inline-block' : 'none';
  resetBtn.disabled = active || isStarting;
  setChatStatus(status);
}

/**
 * Renders the transcript, updating the bubbles in place by message id: model
 * output only ever goes through textContent, and an unchanged bubble keeps
 * the user's text selection. Follows the bottom only if the user was there.
 */
function renderMessages(chat) {
  const messages = chat?.messages ?? [];
  const chatId = chat?.chatId ?? null;
  const switched = chatId !== renderedChatId;
  renderedChatId = chatId;
  const atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 24;

  const existing = new Map([...chatLog.children].map((el) => [el.dataset.id, el]));
  const ids = new Set(messages.map((m) => m.id));
  for (const [id, el] of existing) if (!ids.has(id)) el.remove();

  let previous = null;
  for (const m of messages) {
    let el = existing.get(m.id);
    if (!el) {
      el = document.createElement('div');
      el.dataset.id = m.id;
      const who = document.createElement('span');
      who.className = 'sr-only';
      who.textContent = m.role === 'user' ? 'You: ' : 'Distila: ';
      const text = document.createElement('span');
      text.className = 'msg-text';
      const note = document.createElement('span');
      note.className = 'msg-note';
      el.append(who, text, note);
    }
    el.className = `msg ${m.role} ${m.state}`;
    const [, text, note] = el.children;
    if (text.textContent !== m.text) text.textContent = m.text;
    const noteText = m.state === 'cancelled' ? 'Stopped.' : m.state === 'error' ? 'No answer.' : '';
    if (note.textContent !== noteText) note.textContent = noteText;
    const expected = previous ? previous.nextSibling : chatLog.firstChild;
    if (el !== expected) chatLog.insertBefore(el, expected);
    previous = el;
  }

  if (switched || atBottom) chatLog.scrollTop = chatLog.scrollHeight;
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

  // Progress ticks and queue positions of other tabs' jobs don't change this
  // view: only this tab's job and status changes (the "waiting" hint) do.
  // While a refresh is in flight view.tabId may be about to change and its
  // storage snapshot may predate this change, so any job change counts.
  const ownChatKey = chatKey(view.tabId);
  const relevant = Object.entries(changes).some(
    ([key, { oldValue, newValue }]) =>
      (key.startsWith('job:') &&
        (refreshesInFlight > 0 || key === jobKey(view.tabId) || oldValue?.status !== newValue?.status)) ||
      // A chat starting or stopping to hold the model changes both tabs' state
      // (and the counts); streaming text of this tab's chat is handled below.
      (key.startsWith('chat:') &&
        (refreshesInFlight > 0 || isActiveChat(oldValue) !== isActiveChat(newValue))),
  );
  if (relevant) {
    refresh();
  } else if (changes[ownChatKey]) {
    // Streaming snapshots of this tab's chat: no need to re-read everything
    const chat = changes[ownChatKey].newValue;
    view.chat = chat && samePage(chat.url, view.url) ? chat : null;
    render();
  }
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
  if (document.visibilityState !== 'visible') return;
  probeChatModel(); // a model download may have finished meanwhile
  refresh();
});

// --- Tabs (Chat | Summary) ---

function selectPanel(name, { focus = false } = {}) {
  activePanel = name;
  renderTabs();
  if (focus) (name === 'chat' ? chatTab : summaryTab).focus();
  chrome.storage.sync.set({ panelTab: name }).catch(() => {});
}

chatTab.addEventListener('click', () => selectPanel('chat'));
summaryTab.addEventListener('click', () => selectPanel('summary'));
// Arrow keys/Home/End move between the tabs (WAI-ARIA tabs pattern)
document.querySelector('[role="tablist"]').addEventListener('keydown', (e) => {
  const order = ['chat', 'summary'];
  const i = order.indexOf(activePanel);
  const next = {
    ArrowRight: order[(i + 1) % order.length],
    ArrowLeft: order[(i + order.length - 1) % order.length],
    Home: order[0],
    End: order[order.length - 1],
  }[e.key];
  if (!next) return;
  e.preventDefault();
  selectPanel(next, { focus: true });
});

async function restorePanel() {
  const { panelTab } = await chrome.storage.sync.get('panelTab');
  if (panelTab === 'chat' || panelTab === 'summary') {
    activePanel = panelTab;
    renderTabs();
  }
}

// The panel only probes availability for its hints: the offscreen document
// checks the article's language and creates the sessions.
async function probeChatModel() {
  if (!('LanguageModel' in self)) {
    chatAvailability = 'no-api';
  } else {
    try {
      chatAvailability = await LanguageModel.availability({
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      });
    } catch (err) {
      console.error(err);
      chatAvailability = 'available'; // let the offscreen document report it
    }
  }
  render();
}

restoreFilters();
restorePanel();
probeChatModel();
refresh();

summarizeBtn.addEventListener('click', async () => {
  // Pin the tab at click time: the user may switch tabs while the text is
  // extracted, and the job must stay bound to the page it was started on.
  const { tabId } = view;
  if (tabId == null) return;
  let url = view.url;
  const notify = (text) => notices.set(tabId, { url, text });

  notices.delete(tabId);
  starting.add(tabId);
  render();

  try {
    if (view.chatsElsewhere || isActiveChat(view.chat)) {
      notify(CHAT_BUSY_MSG);
      return;
    }
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
    // just reflect its state: the queue keeps going if the panel closes. The
    // reply arrives once the job's queued/running state is stored.
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

    if (!response?.ok) {
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

cancelBtn.addEventListener('click', async () => {
  // Pin the job on screen: the user may switch tabs before the reply
  const { tabId, job } = view;
  if (tabId == null || !isActiveJob(job)) return;
  // Disabling the focused button below drops its focus, so remember it here
  const hadFocus = document.activeElement === cancelBtn;

  cancelling.add(tabId);
  render();
  try {
    const response = await chrome.runtime.sendMessage({
      target: 'background',
      action: 'cancel-job',
      tabId,
      jobId: job.jobId,
    });
    if (response?.cancelled) notices.set(tabId, { url: job.url, text: 'Cancelled.' });
  } catch (err) {
    console.error(err);
    notices.set(tabId, { url: job.url, text: `Error: ${err.message || err}` });
  } finally {
    cancelling.delete(tabId);
    await refresh();
    if (hadFocus) (cancelBtn.style.display === 'none' ? summarizeBtn : cancelBtn).focus();
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

// --- Chat ---

chatInput.addEventListener('keydown', (e) => {
  // Enter sends, Shift+Enter is a new line; never mid-IME composition
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!askBtn.disabled) chatForm.requestSubmit();
  }
});

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  // Pin the tab at submit time, as for summaries
  const { tabId } = view;
  const question = chatInput.value.trim();
  if (tabId == null || !question || askBtn.disabled) return;
  let url = view.url;
  const notify = (text) => chatNotices.set(tabId, { url, text });
  let sent = false;

  chatNotices.delete(tabId);
  chatStarting.add(tabId);
  render();

  try {
    if (!('LanguageModel' in self)) {
      notify(NO_PROMPT_API_MSG);
      return;
    }

    // The text is extracted for every question: it re-checks the activeTab
    // grant, and lets the offscreen document rebuild a session it dropped.
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

    // The reply arrives once the question and the empty answer are stored;
    // the answer then streams in through chrome.storage.session.
    const response = await chrome.runtime.sendMessage({
      target: 'background',
      action: 'chat-ask',
      payload: { tabId, url, articleText, question },
    });
    if (response?.ok) sent = true;
    else notify(`Error: ${response?.error || 'could not send the question.'}`);
  } catch (err) {
    console.error(err);
    notify(`Error: ${err.message || err}`);
  } finally {
    chatStarting.delete(tabId);
    if (sent) {
      // Clear the question that was sent, wherever its draft is now
      if (view.tabId === tabId) {
        if (chatInput.value.trim() === question) chatInput.value = '';
      } else if (drafts.get(tabId)?.trim() === question) {
        drafts.delete(tabId);
      }
    }
    await refresh();
  }
});

stopBtn.addEventListener('click', async () => {
  // Pin the chat on screen: the user may switch tabs before the reply
  const { tabId, chat } = view;
  if (tabId == null || !isActiveChat(chat)) return;
  const hadFocus = document.activeElement === stopBtn;

  chatCancelling.add(tabId);
  render();
  try {
    await chrome.runtime.sendMessage({
      target: 'background',
      action: 'chat-cancel',
      tabId,
      chatId: chat.chatId,
    });
  } catch (err) {
    console.error(err);
    chatNotices.set(tabId, { url: chat.url, text: `Error: ${err.message || err}` });
  } finally {
    chatCancelling.delete(tabId);
    await refresh();
    if (hadFocus) chatInput.focus();
  }
});

resetBtn.addEventListener('click', async () => {
  const { tabId, chat } = view;
  if (tabId == null || !chat || isActiveChat(chat)) return;
  chatNotices.delete(tabId);
  try {
    await chrome.runtime.sendMessage({
      target: 'background',
      action: 'chat-reset',
      tabId,
      chatId: chat.chatId,
    });
  } catch (err) {
    console.error(err);
    chatNotices.set(tabId, { url: chat.url, text: `Error: ${err.message || err}` });
  } finally {
    await refresh();
    chatInput.focus();
  }
});
