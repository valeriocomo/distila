const summarizeBtn = document.getElementById('summarizeBtn');
const copyBtn = document.getElementById('copyBtn');
const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');
const typeSelect = document.getElementById('typeSelect');
const lengthSelect = document.getElementById('lengthSelect');

const CHUNK_SIZE = 3000; // characters, ~750 tokens per Chrome's docs

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

/**
 * Splits the text into chunks without breaking words/sentences, respecting
 * paragraphs when possible (the "summary of summaries" approach).
 */
function splitIntoChunks(text, chunkSize = CHUNK_SIZE) {
  const paragraphs = text.split(/\n+/).filter(p => p.trim().length > 0);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if (para.length > chunkSize) {
      // Single paragraph too long: split by sentences
      const sentences = para.match(/[^.!?]+[.!?]+|\S+$/g) || [para];
      for (const sentence of sentences) {
        if ((current + ' ' + sentence).length > chunkSize) {
          if (current) chunks.push(current.trim());
          current = sentence;
        } else {
          current += ' ' + sentence;
        }
      }
    } else if ((current + '\n' + para).length > chunkSize) {
      chunks.push(current.trim());
      current = para;
    } else {
      current += '\n' + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Summarizes each chunk with "compressed" settings (tldr, plain-text, long)
 * to preserve as much context as possible, then concatenates the results.
 * If the concatenated result is still too long, it repeats recursively
 * (the "summary of summaries" technique described in Chrome's docs).
 */
async function recursiveSummaryOfSummaries(chunks, onProgress) {
  const partialSummarizer = await Summarizer.create({
    type: 'tldr',
    format: 'plain-text',
    length: 'long',
    sharedContext: 'Summarize while keeping the main factual points of the text.',
  });

  let summaries = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress(`Summarizing section ${i + 1}/${chunks.length}...`);
    const summary = await partialSummarizer.summarize(chunks[i]);
    summaries.push(summary);
  }

  let combined = summaries.join('\n');

  // If the combined result still exceeds the threshold, summarize recursively
  while (combined.length > CHUNK_SIZE && summaries.length > 1) {
    const newChunks = splitIntoChunks(combined);
    summaries = [];
    for (let i = 0; i < newChunks.length; i++) {
      onProgress(`Compressing further (${i + 1}/${newChunks.length})...`);
      const summary = await partialSummarizer.summarize(newChunks[i]);
      summaries.push(summary);
    }
    combined = summaries.join('\n');
  }

  return combined;
}

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

    const [{ result: articleText }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractArticleText,
    });

    if (!articleText || articleText.trim().length < 50) {
      setStatus('Could not find enough text on the page.');
      return;
    }

    const availability = await Summarizer.availability();
    if (availability === 'unavailable') {
      setStatus('The summarization model is not available on this device.');
      return;
    }

    const userType = typeSelect.value;
    const userLength = lengthSelect.value;

    let textToSummarize = articleText;

    // If the text is too long for a single call, apply the
    // "summary of summaries" technique before the final summary.
    if (articleText.length > CHUNK_SIZE * 1.2) {
      const chunks = splitIntoChunks(articleText);
      textToSummarize = await recursiveSummaryOfSummaries(chunks, setStatus);
    }

    setStatus('Generating the final summary...');

    const finalSummarizer = await Summarizer.create({
      type: userType,
      format: 'markdown',
      length: userLength,
      sharedContext: 'This is an article found on a web page.',
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          setStatus(`Downloading model: ${Math.round(e.loaded * 100)}%`);
        });
      },
    });

    const finalSummary = await finalSummarizer.summarize(textToSummarize, {
      context: 'Summary intended for a reader who wants to quickly grasp the main points.',
    });

    outputEl.textContent = finalSummary;
    copyBtn.style.display = 'block';
    setStatus('Done.');
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message || err}`);
  } finally {
    summarizeBtn.disabled = false;
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