/**
 * Minimal coordinator service worker. It cannot run the Summarizer API itself
 * (the API requires a document context), so it opens the side panel, makes
 * sure the offscreen document exists, forwards summarization and cancel
 * requests to it, persists the job state it relays back and mirrors that state
 * on the toolbar badge. This way jobs keep running (and queueing) even if the
 * panel closes or the user switches tabs.
 */

importScripts('common.js'); // jobKey, samePage, isActiveJob

const OFFSCREEN_URL = 'offscreen.html';
const POPUP_FALLBACK_URL = 'sidepanel.html?mode=popup';

// Browsers without the side panel API get the same page as the action popup.
const HAS_SIDE_PANEL = typeof chrome.sidePanel?.open === 'function';

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
  // The new grant makes the tab's url readable again (e.g. back from another
  // site), which is what the badge needs to match it with its job.
  syncBadge(tab.id).catch(console.error);
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

  creatingOffscreen = (async () => {
    // No document but queued/running jobs in storage: the previous document
    // died and took its in-memory queue with it. (Chrome never closes a
    // DOM_PARSER offscreen document by itself; a crash or an explicit close
    // does.) Mark them before the new document gets its first job.
    await withStorageLock(markInterruptedJobs);
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      // There is no AI-specific reason in the enum; DOM_PARSER is the closest fit.
      // https://developer.chrome.com/docs/extensions/reference/api/offscreen#type-Reason
      reasons: ['DOM_PARSER'],
      justification: 'Run the on-device Summarizer API, which requires a document context',
    });
  })().finally(() => {
    creatingOffscreen = null;
  });
  await creatingOffscreen;
}

// Returns whether the offscreen document exists, without creating it: a
// cancel must never spin up a document just to find nothing to cancel.
async function hasOffscreenDocument() {
  if (creatingOffscreen) await creatingOffscreen.catch(() => {});
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

// Asks the offscreen document to cancel the tab's job (only the given one
// when jobId is set). Resolves to its reply, or null without a document.
async function forwardCancel(tabId, jobId) {
  if (!(await hasOffscreenDocument())) return null;
  return chrome.runtime.sendMessage({ target: 'offscreen', action: 'cancel-job', tabId, jobId });
}

// Serializes every chrome.storage.session write in this worker (job keys,
// langByTab, cleanup on tab close), so e.g. a late job update can't land
// after its tab's entries were removed. Never await a message reply inside
// it: the offscreen document's jobs-update needs the lock to be answered, and
// start and cancel requests wait for such updates. The lock isn't reentrant
// either: code running under it calls the unlocked helpers (writeJobs,
// markInterruptedJobs), never the locked wrappers.
let storageQueue = Promise.resolve();
function withStorageLock(fn) {
  const run = storageQueue.then(fn);
  storageQueue = run.catch(() => {});
  return run;
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null; // closed
  }
}

const DEFAULT_TITLE = chrome.runtime.getManifest().action?.default_title ?? 'Distila';
const BADGES = {
  running: { text: () => '…', color: '#1a73e8', title: () => 'Distila — Summarizing…' },
  queued: { text: (job) => `#${job.position}`, color: '#5f6368', title: (job) => `Distila — Queued (#${job.position})` },
  done: { text: () => '✓', color: '#188038', title: () => 'Distila — Summary ready' },
  error: { text: () => '!', color: '#d93025', title: () => 'Distila — Summarizing failed' },
};

/**
 * Mirrors the tab's job on its toolbar badge and tooltip, only while the tab
 * shows the job's page: a job finishing after the tab moved on must not mark
 * the new page. Without the "tabs" permission tab.url is only readable while
 * activeTab is granted, so after a cross-origin navigation this clears the
 * badge — matching the panel, which then asks for a click on the icon too.
 */
function showBadge(tab, job) {
  const badge = job && samePage(tab.url, job.url) ? BADGES[job.status] : undefined;
  const tabId = tab.id;
  // Colors are per tab and cleared with the text on navigation: set both.
  return Promise.all([
    chrome.action.setBadgeText({ tabId, text: badge ? badge.text(job) : '' }),
    chrome.action.setTitle({ tabId, title: badge ? badge.title(job) : DEFAULT_TITLE }),
    badge && chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color }),
  ]).catch(() => {}); // the tab may have closed meanwhile
}

/**
 * Applies a batch of job changes relayed by the offscreen document (unlocked:
 * callers hold the storage lock). Removals only delete a key that still holds
 * the same job, so a late removal never wipes a newer job of the tab. Jobs of
 * closed tabs are not stored (that would re-create keys onRemoved dropped);
 * they are returned as dropped so the offscreen document cancels them.
 */
async function writeJobs({ jobs = [], removed = [] }) {
  const dropped = [];
  const tabIds = [...new Set([...jobs, ...removed].map((j) => j.tabId))];
  const tabs = new Map(await Promise.all(tabIds.map(async (id) => [id, await getTab(id)])));

  if (removed.length) {
    const stored = await chrome.storage.session.get(removed.map((r) => jobKey(r.tabId)));
    const gone = removed.filter((r) => stored[jobKey(r.tabId)]?.jobId === r.jobId);
    await chrome.storage.session.remove(gone.map((r) => jobKey(r.tabId)));
    for (const r of gone) {
      const tab = tabs.get(r.tabId);
      if (tab) await showBadge(tab, null);
    }
  }

  const items = {};
  for (const job of jobs) {
    if (tabs.get(job.tabId)) items[jobKey(job.tabId)] = job;
    else dropped.push({ tabId: job.tabId, jobId: job.jobId });
  }
  await chrome.storage.session.set(items);
  for (const job of jobs) {
    const tab = tabs.get(job.tabId);
    if (tab) await showBadge(tab, job);
  }
  return dropped;
}

function applyJobChanges(changes) {
  return withStorageLock(() => writeJobs(changes));
}

// The toolbar badge is per tab and Chrome clears it on every cross-document
// navigation (reload and Back included); this re-applies it from storage.
function syncBadge(tabId) {
  return withStorageLock(async () => {
    const key = jobKey(tabId);
    const { [key]: job } = await chrome.storage.session.get(key);
    if (!job) return; // most page loads: nothing was ever shown on this tab
    const tab = await getTab(tabId);
    if (tab) await showBadge(tab, job);
  });
}

// Unlocked: see ensureOffscreenDocument.
async function markInterruptedJobs() {
  const stored = await chrome.storage.session.get(null);
  const jobs = Object.entries(stored)
    .filter(([key, job]) => key.startsWith('job:') && isActiveJob(job))
    .map(([, job]) => ({
      jobId: job.jobId,
      tabId: job.tabId,
      url: job.url,
      status: 'error',
      message: 'Distila was interrupted. Try again.',
    }));
  if (jobs.length) await writeJobs({ jobs });
}

// Removes a queued/running job the offscreen document doesn't know (its
// document died): the recovery path for a job stuck in the panel.
function removeIfActive(tabId, jobId) {
  return withStorageLock(async () => {
    const key = jobKey(tabId);
    const { [key]: job } = await chrome.storage.session.get(key);
    if (!isActiveJob(job) || (jobId != null && job.jobId !== jobId)) return false;
    await writeJobs({ removed: [{ tabId, jobId: job.jobId }] });
    return true;
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'background') return;

  // The offscreen document has no chrome.storage access, so it relays job
  // state here and the service worker persists it for the panel. The ack is
  // sent only once the state is stored, and lists the jobs dropped because
  // their tab is gone. (sendMessage is promisified: an awaited send rejects if
  // no listener ever calls sendResponse, so every handler must ack.)
  if (message.action === 'jobs-update') {
    applyJobChanges(message)
      .then(
        (dropped) => sendResponse({ ok: true, dropped }),
        (err) => {
          console.error(err);
          sendResponse({ ok: true, dropped: [] });
        },
      );
    return true;
  }

  // Cancel from the panel. Not under the storage lock: the offscreen reply
  // waits for its own jobs-update, which needs the lock. If the offscreen
  // document doesn't know the job (it died with its queue), the stored state
  // is removed here instead.
  if (message.action === 'cancel-job') {
    (async () => {
      const { tabId, jobId } = message;
      let cancelled = false;
      try {
        cancelled = (await forwardCancel(tabId, jobId))?.cancelled === true;
      } catch (err) {
        console.error(err);
      }
      if (!cancelled) cancelled = await removeIfActive(tabId, jobId).catch(() => false);
      sendResponse({ ok: true, cancelled });
    })();
    return true;
  }

  // The offscreen document detects the article language once per page and
  // relays it here; it is cached per tab so later jobs on the same page skip
  // detection. Closing the tab (onRemoved below) drops the entry.
  if (message.action === 'language-detected') {
    const { tabId, url, language } = message;
    withStorageLock(async () => {
      if (tabId == null || !(await getTab(tabId))) return;
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
        // Relay the offscreen reply ({ ok } or { ok: false, error }). It comes
        // after the job's queued/running state is stored, so this must not
        // hold the storage lock.
        const response = await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'start-summarization',
          payload: { ...message.payload, detectedLanguage },
        });
        sendResponse(response ?? { ok: false, error: 'The summarizer did not respond.' });
      } catch (err) {
        console.error(err);
        const error = err.message || String(err);
        await applyJobChanges({ jobs: [{ status: 'error', message: error, tabId, url }] }).catch(console.error);
        sendResponse({ ok: false, error });
      }
    })();
    return true; // keep the message channel open for the async response
  }
});

// "One summary per tab, detected language once per page": drop a tab's job
// and cached language when it goes away, and cancel the job if it is still
// queued or running so it doesn't hold up the queue. (chrome.storage.session
// itself only survives until the browser closes.)
chrome.tabs.onRemoved.addListener((tabId) => {
  forwardCancel(tabId).catch(() => {});
  withStorageLock(async () => {
    await chrome.storage.session.remove(jobKey(tabId));
    const { langByTab = {} } = await chrome.storage.session.get('langByTab');
    if (String(tabId) in langByTab) {
      delete langByTab[String(tabId)];
      await chrome.storage.session.set({ langByTab });
    }
  }).catch(console.error);
});

// Chrome resets per-tab badges on every cross-document navigation, and a
// same-document one (pushState) may lead to another page: re-apply the badge
// for the page the tab now shows. The event has no filter, so this wakes the
// worker for every tab update; the handler returns early for most of them.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    syncBadge(tabId).catch(console.error);
  }
});
