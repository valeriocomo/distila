/**
 * Offscreen document: runs the summarization pipeline. It lives here (not in
 * the popup) so the job survives the popup being closed, and not in the
 * service worker because the Summarizer API requires a document context.
 * Progress and results are written to chrome.storage.session under the "job"
 * key; the popup renders from there.
 */

const CHUNK_SIZE = 3000; // characters, ~750 tokens per Chrome's docs

// Output languages the Gemini Nano model supports (Chrome 149+); on older
// Chrome the runtime Summarizer.availability() probe narrows this further.
const SUPPORTED_OUTPUT_LANGUAGES = ['en', 'es', 'ja', 'de', 'fr'];
const DETECTION_SAMPLE_SIZE = 2000; // chars; article openings detect reliably
const DETECTION_CONFIDENCE_THRESHOLD = 0.5;

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
 * Detects the article language with the LanguageDetector API. Returns a
 * BCP-47 tag, or null when the API is missing, the model is unavailable, or
 * the top result is undetermined/low-confidence — the caller then falls back
 * to English without caching, so a later click can retry.
 */
async function detectLanguage(text, onProgress) {
  if (!('LanguageDetector' in self)) return null;

  try {
    if ((await LanguageDetector.availability()) === 'unavailable') return null;

    const detector = await LanguageDetector.create({
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          onProgress(`Downloading language detector: ${Math.round(e.loaded * 100)}%`);
        });
      },
    });

    try {
      const [top] = await detector.detect(text.slice(0, DETECTION_SAMPLE_SIZE));
      if (!top || top.detectedLanguage === 'und') return null;
      return top.confidence >= DETECTION_CONFIDENCE_THRESHOLD ? top.detectedLanguage : null;
    } finally {
      detector.destroy();
    }
  } catch (err) {
    console.error('Language detection failed', err);
    return null;
  }
}

/**
 * Creates a Translator for the given pair, or returns null when the API is
 * missing or the pair is unsupported (any other availability means create()
 * works, downloading the pair's model on first use).
 */
async function createTranslator(sourceLanguage, targetLanguage, onProgress) {
  if (!('Translator' in self)) return null;

  const availability = await Translator.availability({ sourceLanguage, targetLanguage });
  if (availability === 'unavailable') return null;

  return Translator.create({
    sourceLanguage,
    targetLanguage,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        onProgress(`Downloading translator (${sourceLanguage}→${targetLanguage}): ${Math.round(e.loaded * 100)}%`);
      });
    },
  });
}

/**
 * Translates a long text chunk by chunk (translate() on a whole article is
 * risky), reusing the same chunking as the summarization pipeline.
 */
async function translateInChunks(translator, text, onProgress, label) {
  const chunks = splitIntoChunks(text);
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    await onProgress(`${label} ${i + 1}/${chunks.length}...`);
    out.push(await translator.translate(chunks[i]));
  }
  return out.join('\n');
}

/**
 * Translates a markdown summary line by line, shielding leading structural
 * tokens (headers, bullets, ordered lists) from the translator. Inline
 * formatting may still be altered by the model.
 */
async function translateMarkdownPreserving(translator, markdown) {
  const out = [];
  for (const line of markdown.split('\n')) {
    const m = line.match(/^(\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)?)(.*)$/);
    out.push(m[2].trim() ? m[1] + (await translator.translate(m[2])) : line);
  }
  return out.join('\n');
}

/**
 * Summarizes each chunk with "compressed" settings (tldr, plain-text, long)
 * to preserve as much context as possible, then concatenates the results.
 * If the concatenated result is still too long, it repeats recursively
 * (the "summary of summaries" technique described in Chrome's docs).
 */
async function recursiveSummaryOfSummaries(chunks, onProgress, outputLanguage) {
  const partialSummarizer = await Summarizer.create({
    type: 'tldr',
    format: 'plain-text',
    length: 'long',
    outputLanguage,
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

async function runJob({ articleText, type, length, format = 'markdown', url, tabId, detectedLanguage }) {
  const onProgress = (msg) => updateJob({ progress: msg });

  await setJob({
    status: 'running',
    progress: 'Starting...',
    url,
    type,
    length,
    format,
    startedAt: Date.now(),
  });

  try {
    if (!('Summarizer' in self)) {
      throw new Error('The Summarizer API is not available in this browser (requires Chrome 138+).');
    }

    // Detect the article language once per page: the background caches it per
    // tab and hands it back as detectedLanguage on later jobs for the same url.
    let language = detectedLanguage;
    if (!language) {
      await onProgress('Detecting language...');
      language = await detectLanguage(articleText, onProgress);
      if (language && tabId != null) {
        await chrome.runtime.sendMessage({
          target: 'background',
          action: 'language-detected',
          tabId,
          url,
          language,
        });
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
        // updateJob patches spread currentJob, so every progress update from
        // here on carries the warning along.
        await updateJob({ warning });
      }
    }

    // Unsupported language: translate to English before summarizing. If the
    // pair is unavailable or translation throws, summarize the original text
    // in English anyway — the warning already covers the degraded result.
    let inputText = articleText;
    let translated = false;
    if (warning) {
      try {
        const toEn = await createTranslator(language, 'en', onProgress);
        if (toEn) {
          try {
            inputText = await translateInChunks(toEn, articleText, onProgress, 'Translating section');
            translated = true;
          } finally {
            toEn.destroy();
          }
        }
      } catch (err) {
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
      textToSummarize = await recursiveSummaryOfSummaries(chunks, onProgress, outputLanguage);
    }

    await onProgress('Generating the final summary...');

    const finalSummarizer = await Summarizer.create({
      type,
      format,
      length,
      outputLanguage,
      sharedContext: 'This is an article found on a web page.',
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          onProgress(`Downloading model: ${Math.round(e.loaded * 100)}%`);
        });
      },
    });

    try {
      let finalSummary = await finalSummarizer.summarize(textToSummarize, {
        context: 'Summary intended for a reader who wants to quickly grasp the main points.',
      });

      // Translate the English summary back to the detected language. On
      // failure keep the English summary rather than failing the job.
      if (warning && translated) {
        try {
          await onProgress('Translating summary...');
          const fromEn = await createTranslator('en', language, onProgress);
          if (fromEn) {
            try {
              finalSummary = format === 'markdown'
                ? await translateMarkdownPreserving(fromEn, finalSummary)
                : await fromEn.translate(finalSummary);
            } finally {
              fromEn.destroy();
            }
          }
        } catch (err) {
          console.error('Back-translation failed', err);
        }
      }

      await setJob({ status: 'done', summary: finalSummary, warning, url, type, length, format });
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
