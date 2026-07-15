const summarizeBtn = document.getElementById('summarizeBtn');
const copyBtn = document.getElementById('copyBtn');
const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');
const typeSelect = document.getElementById('typeSelect');
const lengthSelect = document.getElementById('lengthSelect');
const formatSelect = document.getElementById('formatSelect');

// The popup is only a view: the summarization runs in the offscreen document
// (see offscreen.js) so it survives the popup being closed. The popup renders
// the job state stored in chrome.storage.session and re-syncs on every open.

let currentTabUrl = null;

function setStatus(msg) {
  statusEl.textContent = msg;
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

function renderJob(job) {
  // Ignore jobs belonging to a different page
  if (!job || job.url !== currentTabUrl) {
    summarizeBtn.disabled = false;
    return;
  }

  if (job.status === 'running') {
    summarizeBtn.disabled = true;
    copyBtn.style.display = 'none';
    outputEl.textContent = '';
    setStatus(job.progress || 'Summarizing...');
  } else if (job.status === 'done') {
    summarizeBtn.disabled = false;
    outputEl.textContent = job.summary;
    copyBtn.style.display = 'block';
    setStatus('Done.');
  } else if (job.status === 'error') {
    summarizeBtn.disabled = false;
    copyBtn.style.display = 'none';
    setStatus(`Error: ${job.message}`);
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabUrl = tab?.url ?? null;

  const { job } = await chrome.storage.session.get('job');
  renderJob(job);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.job) {
      renderJob(changes.job.newValue);
    }
  });
}

init();

summarizeBtn.addEventListener('click', async () => {
  outputEl.textContent = '';
  copyBtn.style.display = 'none';
  summarizeBtn.disabled = true;

  try {
    if (!('Summarizer' in self)) {
      setStatus('The Summarizer API is not available in this browser (requires Chrome 138+).');
      return;
    }

    setStatus('Extracting text from the page...');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus('Unable to access the active tab.');
      return;
    }
    currentTabUrl = tab.url ?? null;

    const [{ result: articleText }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractArticleText,
    });

    if (!articleText || articleText.trim().length < 50) {
      setStatus('Could not find enough text on the page.');
      return;
    }

    // Hand the job off to the offscreen document (via the service worker) and
    // just reflect its state: the pipeline keeps running if the popup closes.
    setStatus('Starting summarization...');
    const response = await chrome.runtime.sendMessage({
      target: 'background',
      action: 'start-summarization',
      payload: {
        articleText,
        type: typeSelect.value,
        length: lengthSelect.value,
        format: formatSelect.value,
        url: tab.url,
      },
    });

    if (!response?.ok) {
      setStatus(`Error: ${response?.error || 'could not start the summarization.'}`);
    }
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message || err}`);
  } finally {
    // Keep the button disabled only while a job for this page is running;
    // renderJob() re-enables it on done/error.
    const { job } = await chrome.storage.session.get('job');
    if (!(job && job.url === currentTabUrl && job.status === 'running')) {
      summarizeBtn.disabled = false;
    }
  }
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(outputEl.textContent);
    const original = copyBtn.textContent;
    copyBtn.textContent = 'Copied ✔';
    setTimeout(() => (copyBtn.textContent = original), 1500);
  } catch (err) {
    setStatus(`Unable to copy: ${err.message || err}`);
  }
});
