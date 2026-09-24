/**
 * Minimal coordinator service worker. It cannot run the Summarizer API itself
 * (the API requires a document context), so it opens the side panel, makes
 * sure the offscreen document exists, forwards summarization jobs to it and
 * persists the job state it relays back. This way a job keeps running even if
 * the panel closes or the user switches tabs.
 */

const OFFSCREEN_URL = 'offscreen.html';
const POPUP_FALLBACK_URL = 'sidepanel.html?mode=popup';

// Browsers without the side panel API get the same page as the action popup.
const HAS_SIDE_PANEL = typeof chrome.sidePanel?.open === 'function';

// One chrome.storage.session key per tab, so jobs of different tabs never
// share a read-modify-write.
const jobKey = (tabId) => `job:${tabId}`;

// action.setPopup is not persisted across browser restarts for MV3 actions,
// so it is re-applied on every service worker start. The onStartup and
// onInstalled listeners also make sure the worker wakes up at browser start.
function configureAction() {
  return chrome.action.setPopup({ popup: HAS_SIDE_PANEL ? '' : POPUP_FALLBACK_URL }).catch(console.error);
}

configureAction();
chrome.runtime.onStartup.addListener(configureAction);
chrome.runtime.onInstalled.addListener(() => {
  configureAction();
  // openPanelOnActionClick is persisted in the extension prefs: if it were
  // ever true, the icon would toggle the panel without dispatching onClicked
  // or granting activeTab. Pin it off.
  if (HAS_SIDE_PANEL) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
  }
});

// The panel is opened here rather than via setPanelBehavior({
// openPanelOnActionClick: true }): with that behavior Chromium toggles the
// panel WITHOUT granting activeTab (crbug.com/40904917), so the panel could
// never read the page. A plain action click grants activeTab on the clicked
// tab before onClicked fires. Trade-off: the icon doesn't close the panel
// (its own close button does), and every click re-grants access to the
// current tab — which is how the user enables Distila on a tab they switched to.
chrome.action.onClicked.addListener((tab) => {
  if (!HAS_SIDE_PANEL) {
    // Only reachable if the click beat configureAction(): set the popup and
    // try to open it (openPopup is Chrome 127+), else the next click works.
    configureAction().then(() => chrome.action.openPopup?.()).catch(() => {});
    return;
  }

  // open() needs the user gesture, which does not survive an await.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  // An already open panel must re-check its access to the active tab. The
  // send fails harmlessly while a freshly opened panel is still loading.
  chrome.runtime.sendMessage({
    target: 'sidepanel',
    action: 'tab-access-granted',
    windowId: tab.windowId,
    tabId: tab.id,
  }).catch(() => {});
});

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  // Panels in two windows may start jobs at once: share the pending creation
  // instead of calling createDocument() twice (the second call throws). A
  // document still being created may already be listed before its message
  // listener exists, so wait for the creation first.
  if (creatingOffscreen) return creatingOffscreen;
  if (contexts.length > 0) return;

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    // There is no AI-specific reason in the enum; DOM_PARSER is the closest fit.
    // https://developer.chrome.com/docs/extensions/reference/api/offscreen#type-Reason
    reasons: ['DOM_PARSER'],
    justification: 'Run the on-device Summarizer API, which requires a document context',
  }).finally(() => {
    creatingOffscreen = null;
  });
  await creatingOffscreen;
}

// Serializes every chrome.storage.session write in this worker (job keys,
// langByTab, cleanup on tab close), so e.g. a late job update can't land
// after its tab's entries were removed. Never await a message reply inside
// it: the offscreen document's job-update needs the lock to be answered.
let storageQueue = Promise.resolve();
function withStorageLock(fn) {
  const run = storageQueue.then(fn);
  storageQueue = run.catch(() => {});
  return run;
}

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

// Persists a job relayed by the offscreen document, unless its tab is gone:
// a job that outlives its tab must not re-create the key onRemoved dropped.
function saveJob(job) {
  return withStorageLock(async () => {
    if (job?.tabId == null || !(await tabExists(job.tabId))) return;
    await chrome.storage.session.set({ [jobKey(job.tabId)]: job });
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'background') return;

  // The offscreen document has no chrome.storage access, so it relays job
  // state here and the service worker persists it for the panel. The ack is
  // sent only once the state is stored: the offscreen document awaits every
  // update, so writes land in order. (sendMessage is promisified: an awaited
  // send rejects if no listener ever calls sendResponse, so every handler
  // must ack.)
  if (message.action === 'job-update') {
    saveJob(message.job)
      .catch(console.error)
      .finally(() => sendResponse({ ok: true }));
    return true;
  }

  // The offscreen document detects the article language once per page and
  // relays it here; it is cached per tab so later jobs on the same page skip
  // detection. Closing the tab (onRemoved below) drops the entry.
  if (message.action === 'language-detected') {
    const { tabId, url, language } = message;
    withStorageLock(async () => {
      if (tabId == null || !(await tabExists(tabId))) return;
      const { langByTab = {} } = await chrome.storage.session.get('langByTab');
      langByTab[String(tabId)] = { url, language };
      await chrome.storage.session.set({ langByTab });
    })
      .catch(console.error)
      .finally(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.action === 'start-summarization') {
    (async () => {
      const { tabId, url } = message.payload;
      try {
        await ensureOffscreenDocument();
        // Attach the cached detected language, if any, for this tab+url. A url
        // mismatch means the tab navigated to another page: re-detect there.
        const { langByTab = {} } = await chrome.storage.session.get('langByTab');
        const entry = tabId != null ? langByTab[String(tabId)] : undefined;
        const detectedLanguage = entry && entry.url === url ? entry.language : undefined;
        // Relay the offscreen reply ({ ok } or { ok: false, busy }). It comes
        // after the job's first update is stored, so this must not hold the
        // storage lock.
        const response = await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'start-summarization',
          payload: { ...message.payload, detectedLanguage },
        });
        sendResponse(response ?? { ok: false, error: 'The summarizer did not respond.' });
      } catch (err) {
        console.error(err);
        const error = err.message || String(err);
        await saveJob({ status: 'error', message: error, tabId, url }).catch(console.error);
        sendResponse({ ok: false, error });
      }
    })();
    return true; // keep the message channel open for the async response
  }
});

// "One summary per tab, detected language once per page": drop a tab's job
// and cached language when it goes away. (chrome.storage.session itself only
// survives until the browser closes.)
chrome.tabs.onRemoved.addListener((tabId) => {
  withStorageLock(async () => {
    await chrome.storage.session.remove(jobKey(tabId));
    const { langByTab = {} } = await chrome.storage.session.get('langByTab');
    if (String(tabId) in langByTab) {
      delete langByTab[String(tabId)];
      await chrome.storage.session.set({ langByTab });
    }
  }).catch(console.error);
});
