/**
 * Minimal coordinator service worker. It cannot run the Summarizer API itself
 * (the API requires a document context), so it only guarantees that the
 * offscreen document exists and forwards summarization jobs to it. This way
 * the job starts reliably even if the popup closes right after the click.
 */

const OFFSCREEN_URL = 'offscreen.html';

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    // There is no AI-specific reason in the enum; DOM_PARSER is the closest fit.
    // https://developer.chrome.com/docs/extensions/reference/api/offscreen#type-Reason
    reasons: ['DOM_PARSER'],
    justification: 'Run the on-device Summarizer API, which requires a document context',
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'background') return;

  // The offscreen document has no chrome.storage access, so it relays job
  // state here and the service worker persists it for the popup.
  if (message.action === 'job-update') {
    chrome.storage.session.set({ job: message.job });
    // sendMessage is promisified: an awaited send rejects if no listener
    // ever calls sendResponse, so every handler must ack.
    sendResponse({ ok: true });
    return;
  }

  // The offscreen document detects the article language once per page and
  // relays it here; it is cached per tab so later jobs on the same page skip
  // detection. Closing the tab (onRemoved below) drops the entry.
  if (message.action === 'language-detected') {
    (async () => {
      const { tabId, url, language } = message;
      if (tabId != null) {
        const { langByTab = {} } = await chrome.storage.session.get('langByTab');
        langByTab[String(tabId)] = { url, language };
        await chrome.storage.session.set({ langByTab });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.action === 'start-summarization') {
    (async () => {
      try {
        await ensureOffscreenDocument();
        // Attach the cached detected language, if any, for this tab+url. A url
        // mismatch means the tab navigated to another page: re-detect there.
        const { tabId, url } = message.payload;
        const { langByTab = {} } = await chrome.storage.session.get('langByTab');
        const entry = tabId != null ? langByTab[String(tabId)] : undefined;
        const detectedLanguage = entry && entry.url === url ? entry.language : undefined;
        await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'start-summarization',
          payload: { ...message.payload, detectedLanguage },
        });
        sendResponse({ ok: true });
      } catch (err) {
        console.error(err);
        await chrome.storage.session.set({
          job: {
            status: 'error',
            message: err.message || String(err),
            url: message.payload?.url,
          },
        });
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true; // keep the message channel open for the async response
  }
});

// "Detected once per page, lost when the page is closed": drop the cached
// language when its tab goes away. (chrome.storage.session itself only
// survives until the browser closes.)
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { langByTab = {} } = await chrome.storage.session.get('langByTab');
  if (String(tabId) in langByTab) {
    delete langByTab[String(tabId)];
    await chrome.storage.session.set({ langByTab });
  }
});
