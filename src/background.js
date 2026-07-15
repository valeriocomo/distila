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

  if (message.action === 'start-summarization') {
    (async () => {
      try {
        await ensureOffscreenDocument();
        await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'start-summarization',
          payload: message.payload,
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
