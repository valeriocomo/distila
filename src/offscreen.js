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
 *
 * It also hosts the chat sessions (Prompt API, see the "Chat" section below):
 * one per tab+page, kept here for the same reasons. Chat and summaries never
 * use the model at the same time: a chat turn is refused while a summary is
 * queued or running, and a summary while a chat turn is in progress.
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

// ---------------------------------------------------------------------------
// Chat with the page (Prompt API)
//
// One chat per tab, bound to the page (samePage) it was started on. Its base
// session holds the instructions and either the whole article ("context"
// mode, when it fits) or only a fixed overview ("retrieval" mode: the most
// relevant chunks, ranked by BM25, go into every prompt). The conversation
// runs on clones of the base session, so neither "New chat" nor a cancelled
// turn re-processes the article. Only the visible transcript is relayed to the
// service worker ("chat:<tabId>"); the article text stays here.
// ---------------------------------------------------------------------------

// Languages the Prompt API's Gemini Nano accepts (narrowed at runtime by
// LanguageModel.availability()).
const CHAT_LANGUAGES = ['en', 'es', 'ja', 'de', 'fr'];
// The whole article goes into the context if instructions + article take at
// most this share of the context window: the rest is left to the conversation.
const CONTEXT_FILL_RATIO = 0.6;
// Retrieval mode: share of the window for excerpts + question, and for the
// replayed Q/A history; context mode: history share when it's replayed.
const RETRIEVAL_PROMPT_RATIO = 0.45;
const RETRIEVAL_HISTORY_RATIO = 0.15;
const CONTEXT_HISTORY_RATIO = 0.25;
const RETRIEVAL_CHUNK_SIZE = 1200; // characters per retrievable chunk
const MAX_RETRIEVED_CHUNKS = 5;
const FALLBACK_CHUNKS = 2; // no lexical match: the opening of the article
const OVERVIEW_MAX_CHARS = 1500;
// Texts longer than this many characters per token of the window can't fit:
// skip measuring them.
const MAX_CHARS_PER_TOKEN = 4;
const MAX_CHAT_SESSIONS = 3; // live base sessions (LRU), they hold model memory
const MAX_QUESTION_TRANSLATORS = 4; // per chat (LRU); a turn uses at most 3
// Questions are short: the detector is less confident on them than on articles
const QUESTION_CONFIDENCE_THRESHOLD = 0.3;
const MAX_CHAT_TURNS = 20; // Q/A pairs remembered for replays
const MAX_STORED_MESSAGES = 100; // visible transcript kept in storage
const CHAT_PUBLISH_INTERVAL = 120; // ms between streaming snapshots
const BM25_K1 = 1.2;
const BM25_B = 0.75;

const chats = new Map(); // tabId -> chat
let chatTurn = null; // the chat preparing or answering (one at a time)
const chatTimers = new Map(); // tabId -> pending throttled snapshot

// The Prompt API renamed its quota members after Chrome 138 (inputQuota ->
// contextWindow, inputUsage -> contextUsage, measureInputUsage() ->
// measureContextUsage(), "quotaoverflow" -> "contextoverflow"): support both.
function contextWindowOf(session) {
  return session.contextWindow ?? session.inputQuota ?? Infinity;
}

function contextUsageOf(session) {
  return session.contextUsage ?? session.inputUsage ?? 0;
}

async function measureUsage(session, input, options) {
  const measure = session.measureContextUsage ?? session.measureInputUsage;
  return measure ? measure.call(session, input, options) : Math.ceil(input.length / 3);
}

// Fired when Chrome dropped the oldest Q/A pairs to fit a prompt (the system
// prompt is never dropped).
function onContextOverflow(session, handler) {
  session.addEventListener?.('contextoverflow', handler);
  session.addEventListener?.('quotaoverflow', handler);
}

const isQuotaError = (err) => err?.name === 'QuotaExceededError';

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
function languageName(code) {
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
}

// `languages`: those the article and the questions may come in and the
// answers may go out in (the instructions are always in English).
function chatModelOptions(languages) {
  return {
    expectedInputs: [{ type: 'text', languages: [...new Set([...languages, 'en'])] }],
    expectedOutputs: [{ type: 'text', languages }],
  };
}

async function chatModelAvailability(languages) {
  try {
    return await LanguageModel.availability(chatModelOptions(languages));
  } catch (err) {
    console.error('LanguageModel.availability failed', err);
    return 'unavailable';
  }
}

// The answer language is not here: it changes with every question, and the
// base session (which already read the article) must not be rebuilt for it.
function chatInstructions() {
  return [
    'You are Distila, an assistant that answers questions about one web page article.',
    'Answer only from the article text or the article excerpts you are given; never use outside knowledge.',
    'If the answer is not in the text, say that the article does not say.',
    'Be concise and answer in plain text, without markdown.',
  ].join('\n');
}

// Appended after every question: the end of the prompt weighs the most, so a
// small model is less tempted to drift into the article's language.
function answerInstruction(language) {
  return `\n\nAnswer in ${languageName(language)}.`;
}

const baseLanguage = (tag) => String(tag).split('-')[0].toLowerCase();

// --- BM25 over the article chunks (retrieval mode) ---

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// Lowercased, accent-folded words; scripts without spaces (CJK) are indexed
// as character bigrams.
function tokenize(text) {
  const words = text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens = [];
  for (const word of words) {
    if (CJK.test(word)) {
      const chars = [...word];
      if (chars.length === 1) tokens.push(word);
      for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
    } else if (word.length > 1 || /\p{N}/u.test(word)) {
      tokens.push(word);
    }
  }
  return tokens;
}

function buildIndex(chunks) {
  const docs = chunks.map((chunk) => {
    const tokens = tokenize(chunk);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { tf, length: tokens.length };
  });
  const df = new Map();
  for (const { tf } of docs) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / (docs.length || 1) || 1;
  return { docs, df, avgLength };
}

// Chunk indices matching the weighted query terms, best first.
function rankChunks(index, terms) {
  const n = index.docs.length;
  return index.docs
    .map(({ tf, length }, i) => {
      let score = 0;
      for (const [term, weight] of terms) {
        const f = tf.get(term);
        if (!f) continue;
        const df = index.df.get(term);
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += weight * idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * length / index.avgLength));
      }
      return { i, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ i }) => i);
}

// --- Chat lifecycle ---

// Every model session an operation (one question: preparation + answer)
// creates is tracked, so a cancel can destroy it (Chrome 138 doesn't stop the
// model on abort alone). Sessions that outlive the operation (base session,
// translators, context-mode conversation) are handed over with keep().
function createOp(msgId) {
  const controller = new AbortController();
  const op = { controller, signal: controller.signal, sessions: new Set(), msgId };
  op.track = (session) => {
    if (op.signal.aborted) {
      session.destroy();
      op.signal.throwIfAborted();
    }
    op.sessions.add(session);
    return session;
  };
  op.keep = (session) => {
    op.sessions.delete(session);
    return session;
  };
  return op;
}

function abortOp(op) {
  op.controller.abort();
  for (const session of op.sessions) session.destroy();
  op.sessions.clear();
}

function chatSnapshot(chat) {
  return { ...chat.state, messages: chat.state.messages.map((m) => ({ ...m })) };
}

/**
 * Relays chat changes to the service worker through the outbox, in order with
 * the job updates. Its reply lists the chats it did not store because their
 * tab is gone or shows another page: they are destroyed here.
 */
function sendChats({ chats: changed = [], removed = [] }) {
  const sent = send({
    action: 'chats-update',
    chats: changed.map(chatSnapshot),
    removed: removed.map((chat) => ({ tabId: chat.tabId, chatId: chat.id })),
  });
  sent.then((ack) => {
    for (const { tabId, chatId } of ack?.dropped ?? []) {
      const chat = chats.get(tabId);
      if (chat?.id === chatId) destroyChat(chat, { publish: false });
    }
  }, () => {});
  return sent;
}

// Streaming snapshots are coalesced (at most one per CHAT_PUBLISH_INTERVAL,
// always the latest state); `now` sends right away (state changes).
function publishChat(chat, { now = false } = {}) {
  if (chats.get(chat.tabId) !== chat) return Promise.resolve();
  if (!now) {
    if (!chatTimers.has(chat.tabId)) {
      chatTimers.set(chat.tabId, setTimeout(() => {
        chatTimers.delete(chat.tabId);
        if (chats.get(chat.tabId) === chat) sendChats({ chats: [chat] });
      }, CHAT_PUBLISH_INTERVAL));
    }
    return Promise.resolve();
  }
  clearTimeout(chatTimers.get(chat.tabId));
  chatTimers.delete(chat.tabId);
  return sendChats({ chats: [chat] });
}

function patchChat(chat, patch, options) {
  chat.state = { ...chat.state, ...patch };
  return publishChat(chat, options);
}

// Like patchChat, but muted once the operation was cancelled or replaced.
function setChatState(chat, op, patch) {
  if (chat.op === op) patchChat(chat, patch);
}

function dropConversation(chat) {
  chat.conv?.destroy();
  chat.conv = null;
}

// Frees the chat's model memory; its transcript and Q/A turns are kept, and
// the next question prepares it again (the panel always sends the text).
function destroyChatSessions(chat) {
  for (const session of [chat.conv, chat.base, chat.translators?.toEn, ...chat.questionTranslators.values()]) {
    session?.destroy();
  }
  chat.conv = null;
  chat.base = null;
  chat.translators = null;
  chat.questionTranslators.clear();
  chat.chunks = null;
  chat.index = null;
  chat.translatedChunks = new Map();
}

function destroyChat(chat, { publish = true } = {}) {
  if (chats.get(chat.tabId) !== chat) return;
  if (chat.op) abortOp(chat.op);
  chat.op = null;
  if (chatTurn === chat) chatTurn = null;
  clearTimeout(chatTimers.get(chat.tabId));
  chatTimers.delete(chat.tabId);
  destroyChatSessions(chat);
  chats.delete(chat.tabId);
  if (publish) sendChats({ removed: [chat] });
}

// Keeps at most MAX_CHAT_SESSIONS base sessions alive, evicting the least
// recently used idle chats.
function evictIdleSessions(except) {
  const live = [...chats.values()]
    .filter((c) => c !== except && c.base && !c.op)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  while (live.length >= MAX_CHAT_SESSIONS) destroyChatSessions(live.shift());
}

/**
 * Adds the question to the tab's chat (creating it, or replacing a chat of
 * another page) and starts answering it on the next microtask. Throws when
 * the model is busy. Returns the chat and the send of its new state.
 */
function startChatTurn(payload) {
  if (chatTurn) throw new Error('Distila is already answering a question.');
  if (current || queue.length) throw new Error('Distila is summarizing a page. Ask again when it finishes.');
  const question = String(payload.question ?? '').trim();
  if (!question) throw new Error('The question is empty.');
  const { tabId, url } = payload;

  let chat = chats.get(tabId);
  if (chat && !samePage(chat.url, url)) {
    destroyChat(chat);
    chat = null;
  }
  if (!chat) {
    // The service worker hands back the stored transcript of this page when
    // this document lost it (it was restarted): shown, but not remembered.
    const transcript = Array.isArray(payload.transcript)
      ? payload.transcript.filter((m) => m.state !== 'streaming')
      : [];
    const id = crypto.randomUUID();
    chat = {
      id,
      tabId,
      url,
      language: null, // the article's (detected once)
      chatLanguages: [], // those the model reads and writes natively
      articleWarning: undefined,
      questionLanguage: null, // the last question's, for short follow-ups
      mode: null,
      base: null,
      conv: null,
      convPrefix: '',
      translators: null, // { toEn }: the article's, when the model reads it in English
      questionTranslators: new Map(), // "it>en" -> Translator (LRU)
      chunks: null,
      index: null,
      translatedChunks: new Map(),
      turns: [], // { question (as asked), q, a (in the model's language), query (in the article's) }
      op: null,
      lastUsed: 0,
      state: { chatId: id, tabId, url, status: 'ready', messages: transcript, restarted: transcript.length > 0 },
    };
    chats.set(tabId, chat);
  }

  const userMsg = { id: crypto.randomUUID(), role: 'user', text: question, state: 'done' };
  const botMsg = { id: crypto.randomUUID(), role: 'assistant', text: '', state: 'streaming' };
  const op = createOp(botMsg.id);
  chat.op = op;
  chat.lastUsed = Date.now();
  chatTurn = chat;
  chat.state = {
    ...chat.state,
    messages: [...chat.state.messages, userMsg, botMsg].slice(-MAX_STORED_MESSAGES),
    status: chat.base ? 'answering' : 'preparing',
    progress: chat.base ? undefined : 'Reading the article...',
    error: undefined,
  };
  const sent = publishChat(chat, { now: true });
  Promise.resolve()
    .then(() => chat.op === op && runChatTurn(chat, op, payload, question))
    .catch(console.error);
  return { chat, sent };
}

async function runChatTurn(chat, op, payload, question) {
  try {
    if (!('LanguageModel' in self)) {
      throw new Error('The Prompt API is not available in this browser (requires Chrome 138+).');
    }
    if (!chat.base) {
      await prepareChat(chat, op, payload);
      setChatState(chat, op, { status: 'answering', progress: undefined });
    }
    await answerQuestion(chat, op, question);
    finishChatTurn(chat, op, 'done');
  } catch (err) {
    // Cancelled or destroyed: the cancelling side owns the final state.
    if (op.signal.aborted) return;
    console.error(err);
    dropConversation(chat);
    finishChatTurn(chat, op, 'error', err.message || String(err));
  }
}

function finishChatTurn(chat, op, msgState, error) {
  if (chat.op !== op) return;
  for (const session of op.sessions) session.destroy();
  op.sessions.clear();
  chat.op = null;
  if (chatTurn === chat) chatTurn = null;
  const msg = chat.state.messages.find((m) => m.id === op.msgId);
  if (msg) msg.state = msgState;
  patchChat(chat, { status: 'ready', progress: undefined, error }, { now: true });
}

/**
 * Cancels the tab's chat turn (only the given chat when chatId is set). The
 * partial answer stays, marked as cancelled. Idempotent: false when nothing
 * is in progress.
 */
function cancelChat(tabId, chatId) {
  const chat = chats.get(tabId);
  if (!chat?.op || (chatId != null && chat.id !== chatId)) return false;
  const { op } = chat;
  abortOp(op);
  // The conversation was mid-prompt: it's rebuilt from the turns next time.
  dropConversation(chat);
  finishChatTurn(chat, op, 'cancelled');
  return true;
}

// "New chat": forgets the conversation but keeps the base session (the
// article isn't processed again).
function resetChat(tabId, chatId) {
  const chat = chats.get(tabId);
  if (!chat || (chatId != null && chat.id !== chatId)) return false;
  cancelChat(tabId);
  dropConversation(chat);
  chat.convPrefix = '';
  chat.turns = [];
  chat.questionLanguage = null;
  patchChat(chat, {
    messages: [],
    trimmed: false,
    restarted: false,
    error: undefined,
    warning: chat.articleWarning,
  }, { now: true });
  return true;
}

async function prepareChat(chat, op, { articleText, detectedLanguage, overview }) {
  const { signal, track } = op;
  const onProgress = (progress) => setChatState(chat, op, { progress });
  const ctx = { signal, track, onProgress };
  evictIdleSessions(chat);

  // Same per-page language cache as the summaries (langByTab)
  let language = detectedLanguage || chat.language;
  if (!language) {
    onProgress('Detecting language...');
    language = await detectLanguage(articleText, ctx);
    if (language) {
      send({ action: 'language-detected', tabId: chat.tabId, url: chat.url, language }).catch(() => {});
    }
  }
  chat.language = language;
  const base = language ? baseLanguage(language) : 'en';

  // The languages the model handles natively: the article is read in one of
  // them, each answer is written in one of them (see answerQuestion).
  const available = [];
  for (const lang of CHAT_LANGUAGES) {
    if ((await chatModelAvailability([lang])) !== 'unavailable') available.push(lang);
  }
  if (!available.includes('en')) {
    throw new Error('The chat model is not available on this device.');
  }

  // Article in an unsupported language: the model reads it in English
  // (translated). Without a translator it reads it as is. The answer language
  // is decided per question.
  let warning;
  let toEn = null;
  const untranslated = () => {
    toEn?.destroy();
    toEn = null;
    warning = `The article's language "${base}" is not supported by the chat model — answers may contain errors.`;
  };
  if (base !== 'en' && !available.includes(base)) {
    try {
      toEn = await createTranslator(language, 'en', ctx);
    } catch (err) {
      if (signal.aborted) throw err;
      console.error('Article translator unavailable', err);
    }
    if (toEn) {
      warning = `The article's language "${base}" is not supported by the chat model — it is translated, answers may contain errors.`;
    } else {
      untranslated();
    }
  }
  chat.articleWarning = warning;
  setChatState(chat, op, { warning });

  // All the languages at once, so any question gets a native answer; fall
  // back to English only if the device can't offer the whole set.
  chat.chatLanguages = (await chatModelAvailability(available)) === 'unavailable' ? ['en'] : available;
  const options = chatModelOptions(chat.chatLanguages);
  const instructions = chatInstructions();
  const createSession = async (system) => track(await LanguageModel.create({
    ...options,
    initialPrompts: [{ role: 'system', content: system }],
    signal,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        onProgress(`Downloading model: ${Math.round(e.loaded * 100)}%`);
      });
    },
  }));

  // Quota check before loading the article: a session with the instructions
  // only measures it.
  onProgress('Reading the article...');
  const probe = await createSession(instructions);
  const contextWindow = contextWindowOf(probe);
  let fits = false;
  if (articleText.length <= contextWindow * MAX_CHARS_PER_TOKEN) {
    try {
      const tokens = await measureUsage(probe, articleText, { signal });
      fits = contextUsageOf(probe) + tokens <= contextWindow * CONTEXT_FILL_RATIO;
    } catch (err) {
      if (signal.aborted) throw err;
      console.error('Measuring the article failed', err);
    }
  }

  let session = null;
  let mode = 'retrieval';
  if (fits) {
    let text = articleText;
    if (toEn) {
      try {
        text = await translateInChunks(toEn, articleText, ctx, 'Translating section');
      } catch (err) {
        if (signal.aborted) throw err;
        console.error('Translating the article failed', err);
        untranslated();
        chat.articleWarning = warning;
        setChatState(chat, op, { warning });
      }
    }
    try {
      onProgress('Reading the article...');
      session = await createSession(`${instructions}\n\nARTICLE:\n${text}`);
      mode = 'context';
    } catch (err) {
      // The (translated) text came out longer than measured: use retrieval
      if (signal.aborted || !isQuotaError(err)) throw err;
    }
  }

  if (session) {
    chat.chunks = null;
    chat.index = null;
  } else {
    chat.chunks = splitIntoChunks(articleText, RETRIEVAL_CHUNK_SIZE);
    chat.index = buildIndex(chat.chunks);
    chat.translatedChunks = new Map();
    // A summary of this page, if one was made, is the fixed context; it isn't
    // computed for the chat (it would hold the model for minutes).
    let summary = overview ? String(overview).slice(0, OVERVIEW_MAX_CHARS) : '';
    if (summary && toEn) {
      try {
        summary = await toEn.translate(summary, { signal });
      } catch (err) {
        if (signal.aborted) throw err;
        summary = '';
      }
    }
    session = summary
      ? await createSession(`${instructions}\n\nOVERVIEW OF THE ARTICLE (a summary of it):\n${summary}`)
      : probe;
  }
  if (session !== probe) probe.destroy();

  chat.base = op.keep(session);
  chat.translators = toEn ? { toEn: op.keep(toEn) } : null;
  chat.mode = mode;
  chat.conv = null;
  chat.convPrefix = '';
  setChatState(chat, op, { mode });
  console.info('Distila chat ready', {
    tabId: chat.tabId,
    mode,
    articleLanguage: base,
    translated: !!toEn,
    chatLanguages: chat.chatLanguages,
    contextWindow,
  });
}

/**
 * A fresh conversation on a clone of the base session, with the latest Q/A
 * turns replayed within the history budget (oldest dropped first, the system
 * prompt always kept). Without session.append() the turns go into the next
 * prompt's text instead (`prefix`).
 */
async function rebuildConversation(chat, op) {
  const { signal, track } = op;
  const conv = track(await chat.base.clone({ signal }));
  onContextOverflow(conv, () => patchChat(chat, { trimmed: true }));

  const ratio = chat.mode === 'context' ? CONTEXT_HISTORY_RATIO : RETRIEVAL_HISTORY_RATIO;
  let budget = contextWindowOf(conv) * ratio;
  const kept = [];
  for (let i = chat.turns.length - 1; i >= 0; i--) {
    const { q, a } = chat.turns[i];
    const cost = await measureUsage(conv, `${q}\n${a}`, { signal });
    if (cost > budget) break;
    budget -= cost;
    kept.unshift(chat.turns[i]);
  }
  if (kept.length < chat.turns.length && !chat.state.trimmed) patchChat(chat, { trimmed: true });

  let prefix = '';
  if (kept.length) {
    if (typeof conv.append === 'function') {
      await conv.append(
        kept.flatMap(({ q, a }) => [{ role: 'user', content: q }, { role: 'assistant', content: a }]),
        { signal },
      );
    } else {
      prefix = `PREVIOUS CONVERSATION:\n${kept.map(({ q, a }) => `User: ${q}\nAssistant: ${a}`).join('\n')}\n\n`;
    }
  }
  return { conv, prefix };
}

// The chunk in the model's language (translated on first use, then cached).
async function excerptText(chat, op, i) {
  const toEn = chat.translators?.toEn;
  if (!toEn) return chat.chunks[i];
  if (!chat.translatedChunks.has(i)) {
    chat.translatedChunks.set(i, await toEn.translate(chat.chunks[i], { signal: op.signal }));
  }
  return chat.translatedChunks.get(i);
}

function formatRetrievalPrompt(excerpts, question, prefix) {
  const body = [...excerpts]
    .sort((a, b) => a.i - b.i) // document order reads better than score order
    .map(({ i, text }) => `[Excerpt ${i + 1}]\n${text}`)
    .join('\n\n');
  return `${prefix}ARTICLE EXCERPTS:\n\n${body}\n\nQUESTION: ${question}`;
}

/**
 * Picks the chunks most relevant to the question (and, at half weight, to the
 * previous one, for follow-ups) while the prompt fits its budget.
 */
async function retrievalPrompt(chat, op, conv, query, modelQuestion, prefix) {
  const previous = chat.turns.at(-1);
  const terms = new Map();
  for (const t of tokenize(previous?.query ?? previous?.question ?? '')) terms.set(t, 0.5);
  for (const t of tokenize(query)) terms.set(t, 1);
  let ranked = rankChunks(chat.index, terms).slice(0, MAX_RETRIEVED_CHUNKS);
  if (!ranked.length) ranked = chat.chunks.slice(0, FALLBACK_CHUNKS).map((_, i) => i);

  const budget = contextWindowOf(conv) * RETRIEVAL_PROMPT_RATIO;
  const picked = [];
  let prompt = '';
  for (const i of ranked) {
    if (chat.translators && !chat.translatedChunks.has(i)) {
      setChatState(chat, op, { progress: 'Translating passages...' });
    }
    const candidate = [...picked, { i, text: await excerptText(chat, op, i) }];
    const text = formatRetrievalPrompt(candidate, modelQuestion, prefix);
    if (picked.length && (await measureUsage(conv, text, { signal: op.signal })) > budget) break;
    picked.push(candidate.at(-1));
    prompt = text;
  }
  return prompt;
}

/**
 * Streams the English answer translated back sentence by sentence (line by
 * line inside a sentence group, so line breaks and lists survive).
 */
function sentenceTranslator(translator, signal, emit) {
  const BOUNDARY = /[.!?]+["')\]]*\s+|\n+/g;
  let buffer = '';
  async function translateSegment(segment) {
    let out = '';
    for (const part of segment.split(/(\n+)/)) {
      if (!part.trim()) {
        out += part;
        continue;
      }
      const lead = part.match(/^\s*/)[0];
      const trail = part.match(/\s*$/)[0];
      out += lead + (await translator.translate(part.trim(), { signal })) + trail;
    }
    return out;
  }
  return {
    async push(delta) {
      buffer += delta;
      let end = 0;
      for (const m of buffer.matchAll(BOUNDARY)) end = m.index + m[0].length;
      if (!end) return;
      const segment = buffer.slice(0, end);
      buffer = buffer.slice(end);
      emit(await translateSegment(segment));
    },
    async flush() {
      if (!buffer) return;
      const rest = buffer;
      buffer = '';
      emit(await translateSegment(rest));
    },
  };
}

function appendAnswer(chat, op, text) {
  if (chat.op !== op || !text) return;
  const msg = chat.state.messages.find((m) => m.id === op.msgId);
  if (!msg) return;
  msg.text += text;
  publishChat(chat);
}

// --- Per-question language ---

// One detector for every question of every chat (created once, kept): it is
// never downloaded from here — the article's detection already did that.
let questionDetector = null; // Promise<LanguageDetector | null>

async function getQuestionDetector() {
  if (!questionDetector) {
    questionDetector = (async () => {
      if (!('LanguageDetector' in self)) return null;
      if ((await LanguageDetector.availability()) !== 'available') return null;
      return LanguageDetector.create();
    })();
  }
  const detector = await questionDetector.catch((err) => {
    console.error('Question language detector unavailable', err);
    return null;
  });
  if (!detector) questionDetector = null; // retried on the next question
  return detector;
}

/**
 * The question's base language code. Short questions ("and him?") are often
 * undetermined: then the previous question's language, the browser's, the
 * article's.
 */
async function detectQuestionLanguage(chat, op, question) {
  try {
    const detector = await getQuestionDetector();
    const [top] = detector ? await detector.detect(question, { signal: op.signal }) : [];
    if (top && top.detectedLanguage !== 'und' && top.confidence >= QUESTION_CONFIDENCE_THRESHOLD) {
      return baseLanguage(top.detectedLanguage);
    }
  } catch (err) {
    if (op.signal.aborted) throw err;
    console.error('Question language detection failed', err);
  }
  const fallback = chat.questionLanguage || navigator.language || chat.language;
  return fallback ? baseLanguage(fallback) : 'en';
}

/**
 * A translator for the pair, or null when it's unavailable. The article's
 * translator is reused; the others are cached per chat (LRU) and survive the
 * turn (kept), so a conversation in one language translates without delay.
 */
async function getTranslator(chat, op, source, target) {
  if (chat.translators && target === 'en' && source === baseLanguage(chat.language)) {
    return chat.translators.toEn;
  }
  const cache = chat.questionTranslators;
  const key = `${source}>${target}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached); // most recently used last
    return cached;
  }

  let translator = null;
  try {
    translator = await createTranslator(source, target, {
      signal: op.signal,
      track: op.track,
      onProgress: (progress) => setChatState(chat, op, { progress }),
    });
  } catch (err) {
    if (op.signal.aborted) throw err;
    console.error(`Translator ${key} unavailable`, err);
  }
  // A cancel may have destroyed it while create() was settling
  op.signal.throwIfAborted();
  if (!translator) return null;

  cache.set(key, op.keep(translator));
  while (cache.size > MAX_QUESTION_TRANSLATORS) {
    const [oldest, session] = cache.entries().next().value;
    cache.delete(oldest);
    session.destroy();
  }
  return translator;
}

/**
 * Retrieval mode: the question in the article's language, since BM25 matches
 * words of the (untranslated) chunks. Directly or through English; the
 * question as is when no translator is available (or the article's language
 * is unknown).
 */
async function searchQuery(chat, op, { question, questionLang, modelQuestion, modelQuestionLang }) {
  if (!chat.language) return question;
  const articleLang = baseLanguage(chat.language);
  if (questionLang === articleLang) return question;
  if (modelQuestionLang === articleLang) return modelQuestion;

  const { signal } = op;
  try {
    const direct = await getTranslator(chat, op, questionLang, articleLang);
    if (direct) {
      setChatState(chat, op, { progress: 'Translating the question...' });
      return await direct.translate(question, { signal });
    }
    if (questionLang !== 'en' && articleLang !== 'en') {
      const toEn = modelQuestionLang === 'en' ? null : await getTranslator(chat, op, questionLang, 'en');
      const fromEn = (modelQuestionLang === 'en' || toEn) && (await getTranslator(chat, op, 'en', articleLang));
      if (fromEn) {
        setChatState(chat, op, { progress: 'Translating the question...' });
        const english = toEn ? await toEn.translate(question, { signal }) : modelQuestion;
        return await fromEn.translate(english, { signal });
      }
    }
  } catch (err) {
    if (signal.aborted) throw err;
    console.error('Translating the question for retrieval failed', err);
  }
  return question;
}

/**
 * Answers in the question's language: natively when the model supports it,
 * otherwise in English translated back sentence by sentence while streaming,
 * or in English (with a warning) when there's no translator for it.
 */
async function answerQuestion(chat, op, question) {
  const { signal } = op;
  const questionLang = await detectQuestionLanguage(chat, op, question);
  chat.questionLanguage = questionLang;

  let modelQuestion = question;
  let modelQuestionLang = questionLang;
  let answerLang = questionLang;
  let fromEn = null;
  let questionWarning;
  if (!chat.chatLanguages.includes(questionLang)) {
    answerLang = 'en';
    const toEn = await getTranslator(chat, op, questionLang, 'en');
    fromEn = toEn && (await getTranslator(chat, op, 'en', questionLang));
    if (fromEn) {
      setChatState(chat, op, { progress: 'Translating the question...' });
      modelQuestion = await toEn.translate(question, { signal });
      modelQuestionLang = 'en';
      questionWarning = `Language "${questionLang}" is not supported by the chat model — questions and answers are translated and may contain errors.`;
    } else {
      questionWarning = `Language "${questionLang}" is not supported by the chat model — answers are in English.`;
    }
  }
  const warning = [chat.articleWarning, questionWarning].filter(Boolean).join(' ') || undefined;
  setChatState(chat, op, { warning });

  const instruction = answerInstruction(answerLang);
  const query = chat.mode === 'context'
    ? undefined
    : await searchQuery(chat, op, { question, questionLang, modelQuestion, modelQuestionLang });

  for (let attempt = 0; ; attempt++) {
    let conv;
    let prompt;
    if (chat.mode === 'context') {
      if (!chat.conv) {
        const rebuilt = await rebuildConversation(chat, op);
        chat.conv = op.keep(rebuilt.conv);
        chat.convPrefix = rebuilt.prefix;
      }
      conv = chat.conv;
      prompt = chat.convPrefix + modelQuestion + instruction;
    } else {
      // Fresh per question: the history holds only Q/A, never the excerpts
      const rebuilt = await rebuildConversation(chat, op);
      conv = rebuilt.conv;
      setChatState(chat, op, { progress: 'Finding relevant passages...' });
      prompt = await retrievalPrompt(chat, op, conv, query, modelQuestion + instruction, rebuilt.prefix);
    }
    setChatState(chat, op, { progress: undefined });

    let answer = '';
    const emit = (text) => appendAnswer(chat, op, text);
    const sink = fromEn ? sentenceTranslator(fromEn, signal, emit) : null;
    try {
      for await (const delta of conv.promptStreaming(prompt, { signal })) {
        answer += delta;
        if (sink) await sink.push(delta);
        else emit(delta);
      }
      if (sink) await sink.flush();
    } catch (err) {
      if (signal.aborted || !isQuotaError(err)) throw err;
      if (answer || attempt > 0) throw new Error('The question is too long for the chat model.');
      // Still too long after Chrome dropped the old turns: retry once
      // without any history.
      dropConversation(chat);
      chat.turns = [];
      chat.convPrefix = '';
      patchChat(chat, { trimmed: true });
      continue;
    } finally {
      if (chat.mode !== 'context') conv.destroy();
    }

    chat.convPrefix = ''; // replayed once, now part of the conversation
    chat.turns.push({ question, q: modelQuestion, a: answer, query });
    if (chat.turns.length > MAX_CHAT_TURNS) chat.turns.shift();
    return;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;

  // Replies are sent once the new state is stored, so the panel's refresh
  // right after already shows it. Every path must ack: the service worker
  // awaits these sends, and an awaited sendMessage rejects if no listener
  // ever calls sendResponse.
  if (message.action === 'start-summarization') {
    // Chat and summaries never share the model
    if (chatTurn) {
      sendResponse({ ok: false, error: 'Distila is answering a chat question. Try again when it finishes.' });
      return;
    }
    // A summary of another page ends the tab's chat
    const chat = chats.get(message.payload.tabId);
    if (chat && !samePage(chat.url, message.payload.url)) destroyChat(chat);

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

  if (message.action === 'chat-ask') {
    let started;
    try {
      started = startChatTurn(message.payload);
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
      return;
    }
    const { chat, sent } = started;
    sent.then(
      (ack) => {
        const dropped = ack?.dropped?.some(({ chatId }) => chatId === chat.id);
        sendResponse(dropped ? { ok: false, error: 'The tab was closed.' } : { ok: true, chatId: chat.id });
      },
      (err) => {
        destroyChat(chat, { publish: false });
        sendResponse({ ok: false, error: err.message || String(err) });
      },
    );
    return true;
  }

  if (message.action === 'chat-cancel') {
    const cancelled = cancelChat(message.tabId, message.chatId);
    outbox.then(() => sendResponse({ ok: true, cancelled }));
    return true;
  }

  if (message.action === 'chat-reset') {
    const reset = resetChat(message.tabId, message.chatId);
    outbox.then(() => sendResponse({ ok: true, reset }));
    return true;
  }

  // Tab closed or navigated away: the service worker already removed the
  // stored transcript, so nothing is published.
  if (message.action === 'chat-destroy') {
    const chat = chats.get(message.tabId);
    const destroyed = !!chat && (message.chatId == null || chat.id === message.chatId);
    if (destroyed) destroyChat(chat, { publish: false });
    sendResponse({ ok: true, destroyed });
  }
});
