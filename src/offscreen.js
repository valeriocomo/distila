/**
 * Offscreen document: runs the summarization pipeline. It lives here (not in
 * the popup) so the job survives the popup being closed, and not in the
 * service worker because the Summarizer API requires a document context.
 * Progress and results are written to chrome.storage.session under the "job"
 * key; the popup renders from there.
 */

const CHUNK_SIZE = 3000; // characters, ~750 tokens per Chrome's docs

let jobRunning = false;
let currentJob = null;

// Offscreen documents can only use chrome.runtime (messaging) — chrome.storage
// is not available here. State is relayed to the service worker, which
// persists it to chrome.storage.session for the popup.
async function setJob(job) {
  currentJob = job;
  await chrome.runtime.sendMessage({ target: 'background', action: 'job-update', job });
}

async function updateJob(patch) {
  await setJob({ ...currentJob, ...patch });
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
    outputLanguage: 'en',
    sharedContext: 'Summarize while keeping the main factual points of the text.',
  });

  try {
    let summaries = [];
    for (let i = 0; i < chunks.length; i++) {
      await onProgress(`Summarizing section ${i + 1}/${chunks.length}...`);
      const summary = await partialSummarizer.summarize(chunks[i]);
      summaries.push(summary);
    }

    let combined = summaries.join('\n');

    // If the combined result still exceeds the threshold, summarize recursively
    while (combined.length > CHUNK_SIZE && summaries.length > 1) {
      const newChunks = splitIntoChunks(combined);
      summaries = [];
      for (let i = 0; i < newChunks.length; i++) {
        await onProgress(`Compressing further (${i + 1}/${newChunks.length})...`);
        const summary = await partialSummarizer.summarize(newChunks[i]);
        summaries.push(summary);
      }
      combined = summaries.join('\n');
    }

    return combined;
  } finally {
    partialSummarizer.destroy();
  }
}

async function runJob({ articleText, type, length, url }) {
  const onProgress = (msg) => updateJob({ progress: msg });

  await setJob({
    status: 'running',
    progress: 'Starting...',
    url,
    type,
    length,
    startedAt: Date.now(),
  });

  try {
    if (!('Summarizer' in self)) {
      throw new Error('The Summarizer API is not available in this browser (requires Chrome 138+).');
    }

    const availability = await Summarizer.availability();
    if (availability === 'unavailable') {
      throw new Error('The summarization model is not available on this device.');
    }

    let textToSummarize = articleText;

    // If the text is too long for a single call, apply the
    // "summary of summaries" technique before the final summary.
    if (articleText.length > CHUNK_SIZE * 1.2) {
      const chunks = splitIntoChunks(articleText);
      textToSummarize = await recursiveSummaryOfSummaries(chunks, onProgress);
    }

    await onProgress('Generating the final summary...');

    const finalSummarizer = await Summarizer.create({
      type,
      format: 'markdown',
      length,
      outputLanguage: 'en',
      sharedContext: 'This is an article found on a web page.',
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          onProgress(`Downloading model: ${Math.round(e.loaded * 100)}%`);
        });
      },
    });

    try {
      const finalSummary = await finalSummarizer.summarize(textToSummarize, {
        context: 'Summary intended for a reader who wants to quickly grasp the main points.',
      });
      await setJob({ status: 'done', summary: finalSummary, url, type, length });
    } finally {
      finalSummarizer.destroy();
    }
  } catch (err) {
    console.error(err);
    await setJob({ status: 'error', message: err.message || String(err), url });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;

  if (message.action === 'start-summarization') {
    // Ack right away: the service worker awaits this send, and an awaited
    // sendMessage rejects if no listener ever calls sendResponse.
    sendResponse({ ok: true });
    if (jobRunning) return; // one job at a time; the popup already shows the running state
    jobRunning = true;
    runJob(message.payload).finally(() => {
      jobRunning = false;
    });
  }
});
