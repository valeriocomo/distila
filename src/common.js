/**
 * Helpers shared by the service worker (background.js, via importScripts) and
 * the side panel (sidepanel.html, via <script>). This is a classic script:
 * its top-level names are globals in both contexts, so neither file may
 * redeclare them.
 */

// One chrome.storage.session key per tab, so jobs of different tabs never
// share a read-modify-write.
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

// Waiting in the offscreen document's queue or being summarized right now.
function isActiveJob(job) {
  return job?.status === 'queued' || job?.status === 'running';
}
