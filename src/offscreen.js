/**
 * Offscreen document: runs the summarization pipeline. It lives here (not in
 * the side panel) so jobs survive the panel being closed, and not in the
 * service worker because the Summarizer API requires a document context.
 *
 * Jobs wait in a FIFO queue in this document's memory and run one at a time
 * (there is a single on-device model). The extracted page text never leaves
 * this document: only the job state (queued with its position, running with
 * its progress, done with the summary, or error) is relayed to the service
 * worker, which stores it in chrome.storage.session under "job:<tabId>" for
 * the panel.
 */

const CHUNK_SIZE = 3000; // characters, ~750 tokens per Chrome's docs

// Output languages the Gemini Nano model supports (Chrome 149+); on older
// Chrome the runtime Summarizer.availability() probe narrows this further.
const SUPPORTED_OUTPUT_LANGUAGES = ['en', 'es', 'ja', 'de', 'fr'];
const DETECTION_SAMPLE_SIZE = 2000; // chars; article openings detect reliably
const DETECTION_CONFIDENCE_THRESHOLD = 0.5;

// Queue state. Invariants:
// - `current` holds the running slot and is always live: aborting it hands the
//   slot over in the same synchronous step (see enqueue and cancel).
// - Once an entry lost the slot or was aborted it is muted: update() and
//   finish() ignore it, so no late state of it ever reaches storage.
// - Every message to the service worker goes through `outbox`, in order, so a
//   removal can never be overtaken by an older progress update.
const queue = []; // waiting entries, FIFO: { id, tabId, payload, controller, sessions, job }
let current = null;
let outbox = Promise.resolve();

const SEND_ATTEMPTS = 3;

// Offscreen documents can only use chrome.runtime (messaging) — chrome.storage
// is not available here, so state is relayed to the service worker. A send
// can fail if the worker is stopped while handling it; a lost update would
// leave e.g. a finished job "running" in storage forever, so it is retried
// (the worker's writes are idempotent) before the outbox moves on.
async function sendWithRetry(message) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await chrome.runtime.sendMessage({ target: 'background', ...message });
    } catch (err) {
      if (attempt >= SEND_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
}

function send(message) {
  const sent = outbox.then(() => sendWithRetry(message));
  outbox = sent.catch(console.error);
  return sent;
}

/**
 * Relays job changes to the service worker in one message (one storage
 * write). Its reply lists the jobs it did not store because their tab is
 * gone: they are cancelled here, which covers a tab closed while its start
 * request was still on the way.
 */
function publish({ jobs = [], removed = [] }) {
  const sent = send({
    action: 'jobs-update',
    // Snapshot now: the message may leave later, after further changes
    jobs: jobs.map((entry) => ({ ...entry.job })),
    removed: removed.map((entry) => ({ tabId: entry.tabId, jobId: entry.id })),
  });
  sent.then((ack) => {
    for (const { tabId, jobId } of ack?.dropped ?? []) cancel(tabId, jobId);
  }, () => {});
  return sent;
}

function baseJob(entry) {
  const { tabId, url, type, length, format = 'markdown' } = entry.payload;
  return { jobId: entry.id, tabId, url, type, length, format };
}

function setQueued(entry, position) {
  entry.job = {
    ...baseJob(entry),
    status: 'queued',
    position, // 1 = next to run
    queuedAt: entry.job?.queuedAt ?? Date.now(),
  };
}

// Rewrites every waiting job's position; unchanged ones are free (storing an
// identical value fires no storage.onChanged).
function renumber() {
  queue.forEach((entry, i) => setQueued(entry, i + 1));
  return [...queue];
}

// Gives entry the running slot. The pipeline starts on the next microtask, so
// the caller's publish of the new state goes out before any progress update
// (and doesn't start at all if the entry lost the slot meanwhile).
function run(entry) {
  current = entry;
  entry.job = { ...baseJob(entry), status: 'running', progress: 'Starting...', startedAt: Date.now() };
  Promise.resolve()
    .then(() => current === entry && runJob(entry))
    .catch(console.error);
}

// Frees the slot held by entry and starts the next waiting job. Returns the
// entries whose state changed, for the caller to publish.
function release(entry) {
  if (current !== entry) return [];
  current = null;
  const next = queue.shift();
  if (!next) return [];
  run(next);
  return [next, ...renumber()];
}

function abortEntry(entry) {
  entry.controller.abort();
  // On Chrome 138 an aborted call doesn't stop the model and the create()
  // signal doesn't destroy the session: destroying the job's live sessions
  // is what actually frees the on-device model for the next job.
  for (const session of entry.sessions) session.destroy();
  entry.sessions.clear();
}

/**
 * Adds a job and returns its entry; the caller publishes it. A tab keeps a
 * single summary, so a new request from a tab replaces that tab's job: a
 * waiting one in place, a running one by aborting it and taking over the slot.
 */
function enqueue(payload) {
  const entry = {
    id: crypto.randomUUID(),
    tabId: payload.tabId,
    payload,
    controller: new AbortController(),
    sessions: new Set(),
    job: null,
  };

  const waiting = queue.findIndex((e) => e.tabId === entry.tabId);
  if (current?.tabId === entry.tabId) {
    abortEntry(current);
    run(entry);
  } else if (waiting !== -1) {
    abortEntry(queue[waiting]);
    queue[waiting] = entry;
    setQueued(entry, waiting + 1);
  } else if (current) {
    queue.push(entry);
    setQueued(entry, queue.length);
  } else {
    run(entry);
  }
  return entry;
}

/**
 * Cancels the tab's job (only the given one when jobId is set). Idempotent:
 * returns false when there is nothing to cancel, e.g. the job just finished.
 */
function cancel(tabId, jobId) {
  const matches = (e) => e.tabId === tabId && (jobId == null || e.id === jobId);
  let entry;
  let changed;
  if (current && matches(current)) {
    entry = current;
    abortEntry(entry);
    changed = release(entry);
  } else {
    const i = queue.findIndex(matches);
    if (i === -1) return false;
    [entry] = queue.splice(i, 1);
    abortEntry(entry);
    changed = renumber();
  }
  publish({ jobs: changed, removed: [entry] });
  return true;
}

// Progress of the running job. Repeated values (download percentages) are
// skipped so they don't pile up in the outbox.
function update(entry, patch) {
  if (current !== entry) return;
  if (Object.entries(patch).every(([key, value]) => entry.job[key] === value)) return;
  entry.job = { ...entry.job, ...patch };
  publish({ jobs: [entry] });
}

// Stores the job's result. The slot is freed before the message leaves, so a
// cancel arriving at the same moment finds nothing and the summary is kept.
function finish(entry, job) {
  if (current !== entry) return;
  entry.job = job;
  publish({ jobs: [entry, ...release(entry)] });
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
 * Detects the article language with the LanguageDetector API. Returns a
 * BCP-47 tag, or null when the API is missing, the model is unavailable, or
 * the top result is undetermined/low-confidence — the caller then falls back
 * to English without caching, so a later click can retry.
 */
async function detectLanguage(text, { signal, onProgress, track }) {
  if (!('LanguageDetector' in self)) return null;

  try {
    if ((await LanguageDetector.availability()) === 'unavailable') return null;

    const detector = track(await LanguageDetector.create({
      signal,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          onProgress(`Downloading language detector: ${Math.round(e.loaded * 100)}%`);
        });
      },
    }));

    try {
      const [top] = await detector.detect(text.slice(0, DETECTION_SAMPLE_SIZE), { signal });
      if (!top || top.detectedLanguage === 'und') return null;
      return top.confidence >= DETECTION_CONFIDENCE_THRESHOLD ? top.detectedLanguage : null;
    } finally {
      detector.destroy();
    }
  } catch (err) {
    // A cancellation must stop the job, not fall back to English
    if (signal.aborted) throw err;
    console.error('Language detection failed', err);
    return null;
  }
}

/**
 * Creates a Translator for the given pair, or returns null when the API is
 * missing or the pair is unsupported. create() may still reject (e.g. when
 * the pair's model must be downloaded first): callers fall back on errors.
 */
async function createTranslator(sourceLanguage, targetLanguage, { signal, onProgress, track }) {
  if (!('Translator' in self)) return null;

  const availability = await Translator.availability({ sourceLanguage, targetLanguage });
  if (availability === 'unavailable') return null;

  return track(await Translator.create({
    sourceLanguage,
    targetLanguage,
    signal,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        onProgress(`Downloading translator (${sourceLanguage}→${targetLanguage}): ${Math.round(e.loaded * 100)}%`);
      });
    },
  }));
}

/**
 * Translates a long text chunk by chunk (translate() on a whole article is
 * risky), reusing the same chunking as the summarization pipeline.
 */
async function translateInChunks(translator, text, { signal, onProgress }, label) {
  const chunks = splitIntoChunks(text);
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress(`${label} ${i + 1}/${chunks.length}...`);
    out.push(await translator.translate(chunks[i], { signal }));
  }
  return out.join('\n');
}

/**
 * Translates a markdown summary line by line, shielding leading structural
 * tokens (headers, bullets, ordered lists) from the translator. Inline
 * formatting may still be altered by the model.
 */
async function translateMarkdownPreserving(translator, markdown, { signal }) {
  const out = [];
  for (const line of markdown.split('\n')) {
    const m = line.match(/^(\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)?)(.*)$/);
    out.push(m[2].trim() ? m[1] + (await translator.translate(m[2], { signal })) : line);
  }
  return out.join('\n');
}

/**
 * Summarizes each chunk with "compressed" settings (tldr, plain-text, long)
 * to preserve as much context as possible, then concatenates the results.
 * If the concatenated result is still too long, it repeats recursively
 * (the "summary of summaries" technique described in Chrome's docs).
 */
async function recursiveSummaryOfSummaries(chunks, outputLanguage, { signal, onProgress, track }) {
  const partialSummarizer = track(await Summarizer.create({
    type: 'tldr',
    format: 'plain-text',
    length: 'long',
    outputLanguage,
    sharedContext: 'Summarize while keeping the main factual points of the text.',
    signal,
  }));

  try {
    let summaries = [];
    for (let i = 0; i < chunks.length; i++) {
      onProgress(`Summarizing section ${i + 1}/${chunks.length}...`);
      const summary = await partialSummarizer.summarize(chunks[i], { signal });
      summaries.push(summary);
    }

    let combined = summaries.join('\n');

    // If the combined result still exceeds the threshold, summarize recursively
    while (combined.length > CHUNK_SIZE && summaries.length > 1) {
      const newChunks = splitIntoChunks(combined);
      summaries = [];
      for (let i = 0; i < newChunks.length; i++) {
        onProgress(`Compressing further (${i + 1}/${newChunks.length})...`);
        const summary = await partialSummarizer.summarize(newChunks[i], { signal });
        summaries.push(summary);
      }
      combined = summaries.join('\n');
    }

    return combined;
  } finally {
    partialSummarizer.destroy();
  }
}

async function runJob(entry) {
  const { articleText, type, length, format = 'markdown', url, tabId, detectedLanguage } = entry.payload;
  const { signal } = entry.controller;
  // Every model session this job creates is tracked, so a cancel can destroy
  // it (see abortEntry); one created after the abort is destroyed right away.
  const track = (session) => {
    if (signal.aborted) {
      session.destroy();
      signal.throwIfAborted();
    }
    entry.sessions.add(session);
    return session;
  };
  const ctx = { signal, track, onProgress: (msg) => update(entry, { progress: msg }) };
  const { onProgress } = ctx;
  const fields = baseJob(entry);
  let result;

  try {
    if (!('Summarizer' in self)) {
      throw new Error('The Summarizer API is not available in this browser (requires Chrome 138+).');
    }

    // Detect the article language once per page: the background caches it per
    // tab and hands it back as detectedLanguage on later jobs for the same url.
    let language = detectedLanguage;
    if (!language) {
      onProgress('Detecting language...');
      language = await detectLanguage(articleText, ctx);
      if (language && tabId != null) {
        send({ action: 'language-detected', tabId, url, language }).catch(() => {});
      }
    }

    const base = language ? language.split('-')[0].toLowerCase() : 'en';
    let outputLanguage = 'en';
    let warning;

    if (language && base !== 'en') {
      const supported =
        SUPPORTED_OUTPUT_LANGUAGES.includes(base) &&
        (await Summarizer.availability({ outputLanguage: base })) !== 'unavailable';
      if (supported) {
        outputLanguage = base;
      } else {
        warning = `Language "${base}" not supported — summary may contain errors.`;
        // update() patches the entry's job, so every progress update from
        // here on carries the warning along.
        update(entry, { warning });
      }
    }

    // Unsupported language: translate to English before summarizing. If the
    // pair is unavailable or translation throws, summarize the original text
    // in English anyway — the warning already covers the degraded result.
    let inputText = articleText;
    let translated = false;
    if (warning) {
      try {
        const toEn = await createTranslator(language, 'en', ctx);
        if (toEn) {
          try {
            inputText = await translateInChunks(toEn, articleText, ctx, 'Translating section');
            translated = true;
          } finally {
            toEn.destroy();
          }
        }
      } catch (err) {
        if (signal.aborted) throw err;
        console.error('Translation to English failed', err);
      }
    }

    const availability = await Summarizer.availability({ outputLanguage });
    if (availability === 'unavailable') {
      throw new Error('The summarization model is not available on this device.');
    }

    let textToSummarize = inputText;

    // If the text is too long for a single call, apply the
    // "summary of summaries" technique before the final summary.
    if (inputText.length > CHUNK_SIZE * 1.2) {
      const chunks = splitIntoChunks(inputText);
      textToSummarize = await recursiveSummaryOfSummaries(chunks, outputLanguage, ctx);
    }

    onProgress('Generating the final summary...');

    const finalSummarizer = track(await Summarizer.create({
      type,
      format,
      length,
      outputLanguage,
      sharedContext: 'This is an article found on a web page.',
      signal,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          onProgress(`Downloading model: ${Math.round(e.loaded * 100)}%`);
        });
      },
    }));

    try {
      let finalSummary = await finalSummarizer.summarize(textToSummarize, {
        context: 'Summary intended for a reader who wants to quickly grasp the main points.',
        signal,
      });

      // Translate the English summary back to the detected language. On
      // failure keep the English summary rather than failing the job.
      if (warning && translated) {
        try {
          onProgress('Translating summary...');
          const fromEn = await createTranslator('en', language, ctx);
          if (fromEn) {
            try {
              finalSummary = format === 'markdown'
                ? await translateMarkdownPreserving(fromEn, finalSummary, ctx)
                : await fromEn.translate(finalSummary, { signal });
            } finally {
              fromEn.destroy();
            }
          }
        } catch (err) {
          if (signal.aborted) throw err;
          console.error('Back-translation failed', err);
        }
      }

      result = { ...fields, status: 'done', summary: finalSummary, warning };
    } finally {
      finalSummarizer.destroy();
    }
  } catch (err) {
    // Cancelled or replaced: the cancelling side owns the job's final state.
    // Checked on the signal, not the error: Chrome 138 rejects aborted calls
    // with InvalidStateError, later versions with AbortError.
    if (signal.aborted) return;
    console.error(err);
    result = { ...fields, status: 'error', message: err.message || String(err) };
  }
  finish(entry, result);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;

  // Replies are sent once the new state is stored, so the panel's refresh
  // right after already shows it. Every path must ack: the service worker
  // awaits these sends, and an awaited sendMessage rejects if no listener
  // ever calls sendResponse.
  if (message.action === 'start-summarization') {
    const entry = enqueue(message.payload);
    publish({ jobs: [entry] }).then(
      (ack) => {
        const dropped = ack?.dropped?.some(({ jobId }) => jobId === entry.id);
        sendResponse(dropped ? { ok: false, error: 'The tab was closed.' } : { ok: true });
      },
      (err) => {
        cancel(entry.tabId, entry.id);
        sendResponse({ ok: false, error: err.message || String(err) });
      },
    );
    return true;
  }

  if (message.action === 'cancel-job') {
    const cancelled = cancel(message.tabId, message.jobId);
    outbox.then(() => sendResponse({ ok: true, cancelled }));
    return true;
  }
});
