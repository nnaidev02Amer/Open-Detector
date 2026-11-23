// Pure helpers for Detection Studio and Document Intelligence (no DOM). Every explanation below is built only from
// values the detector returned (scores, bands, word counts); nothing is estimated or invented here.

export const ALLOWED_EXT = [".txt", ".md", ".docx", ".pdf"];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;     // same limit as app/extract.py
export const MAX_TEXT_CHARS = 300000;               // same limit as app/main.py
export const MIN_WORDS = 40;                        // detector.analysis.MIN_WORDS_DOCUMENT
export const MIN_PARAGRAPH_WORDS = 25;              // detector.analysis.MIN_WORDS_PARAGRAPH
export const DEFAULT_BANDS = { human_below: 0.35, ai_above: 0.65 };

const WORD = /[\p{L}\p{N}_][\p{L}\p{N}_'’-]*/gu;
export const countWords = (t) => ((t || "").match(WORD) || []).length;
export const countChars = (t) => (t || "").length;

export function formatBytes(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fileExt(name) { const m = /\.[^.\\/]+$/.exec(name || ""); return m ? m[0].toLowerCase() : ""; }

/** Client-side pre-check of a chosen file. The server still validates; this only gives faster, clearer feedback. */
export function validateFile(file) {
  if (!file) return { ok: false, error: "No file selected." };
  const ext = fileExt(file.name);
  if (!ALLOWED_EXT.includes(ext)) return { ok: false, ext, error: `“${ext || "no extension"}” files are not supported. Use ${ALLOWED_EXT.join(", ")}.` };
  if (file.size === 0) return { ok: false, ext, error: "The file is empty." };
  if (file.size > MAX_FILE_BYTES) return { ok: false, ext, error: `The file is larger than the ${formatBytes(MAX_FILE_BYTES).replace(".0", "")} limit (${file.size.toLocaleString()} bytes).` };
  return { ok: true, ext, kind: { ".txt": "Plain text", ".md": "Markdown", ".docx": "Word document", ".pdf": "PDF document" }[ext] };
}

/** Pre-check of pasted text -> {ok, level: "error"|"warn"|"ok", message}. */
export function validateText(text) {
  const t = (text || "").trim();
  if (!t) return { ok: false, level: "error", message: "Paste some text or upload a file first." };
  if (t.length > MAX_TEXT_CHARS) return { ok: false, level: "error", message: `The text is ${t.length.toLocaleString()} characters; the limit is ${MAX_TEXT_CHARS.toLocaleString()}.` };
  const w = countWords(t);
  if (w < MIN_WORDS) return { ok: true, level: "warn", message: `Only ${w} words. The detector withholds a result below ${MIN_WORDS} words.` };
  return { ok: true, level: "ok", message: "" };
}

export const bandOf = (score, bands = DEFAULT_BANDS) => (score == null ? "none" : score < bands.human_below ? "human" : score > bands.ai_above ? "ai" : "uncertain");
export const BAND_LABEL = { human: "Likely human", uncertain: "Uncertain", ai: "Likely AI", none: "Not scored" };
export const humanProbability = (aiScore) => (aiScore == null ? null : 1 - aiScore);
const P = (v) => `${(v * 100).toFixed(1)}%`;

export function verdictExplanation(result) {
  if (result.status !== "ok") return result.message;
  const b = result.bands || DEFAULT_BANDS, s = result.overall_score, band = bandOf(s, b);
  const rule = band === "human" ? `below the ${P(b.human_below)} human threshold` : band === "ai" ? `above the ${P(b.ai_above)} AI threshold`
    : `between the ${P(b.human_below)} and ${P(b.ai_above)} thresholds, so no verdict is given`;
  return `The word-weighted mean of the paragraph scores is ${P(s)}, which is ${rule}. ` +
    `${result.calibrated ? "Scores are temperature-calibrated." : "Scores are the model's raw output and are not calibrated probabilities."}`;
}

/** Explanation for one paragraph, from its own score and word count and the document totals. */
export function paragraphExplanation(par, result) {
  const b = result.bands || DEFAULT_BANDS;
  if (!par.scored) return `Not scored: this paragraph has ${par.words} words and the detector skips paragraphs under ${MIN_PARAGRAPH_WORDS} words. It does not contribute to the document score.`;
  const band = bandOf(par.score, b), share = result.scored_words ? par.words / result.scored_words : 0;
  const rule = band === "human" ? `below ${P(b.human_below)}` : band === "ai" ? `above ${P(b.ai_above)}` : `between ${P(b.human_below)} and ${P(b.ai_above)}`;
  return `Score ${P(par.score)} is ${rule}, so this paragraph is classed “${BAND_LABEL[band]}”. ` +
    `It has ${par.words} words, ${P(share)} of the ${result.scored_words.toLocaleString()} scored words, and so carries that share of the document score.`;
}

export function sentenceStats(par) {
  const v = (par.sentences || []).filter((s) => s.scored && s.score != null).map((s) => s.score);
  if (!v.length) return null;
  return { n: v.length, min: Math.min(...v), max: Math.max(...v), mean: v.reduce((a, c) => a + c, 0) / v.length };
}

export function histogram(values, bins = 10) {
  const out = new Array(bins).fill(0);
  for (const v of values) if (Number.isFinite(v)) out[Math.min(bins - 1, Math.max(0, Math.floor(v * bins)))]++;
  return out;
}

export function paragraphSummary(result) {
  const scored = result.paragraphs.filter((p) => p.scored), b = result.bands || DEFAULT_BANDS;
  const counts = { human: 0, uncertain: 0, ai: 0 };
  for (const p of scored) counts[bandOf(p.score, b)]++;
  return { total: result.paragraphs.length, scored: scored.length, skipped: result.paragraphs.length - scored.length, counts };
}

export const preview = (text, n = 90) => { const t = (text || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
export const paragraphText = (rec, par) => rec.text.slice(par.start, par.end);

/* ---------- Stage 4: batch, history, analytics helpers ---------- */
export const MAX_BATCH_FILES = 20;                  // same limit as POST /api/batch

/** Pre-validate a list of files for a batch. Only `ready` items are sent to the server. */
export function validateBatch(files) {
  let accepted = 0;
  const items = Array.from(files || []).map((file, i) => {
    const v = validateFile(file);
    if (!v.ok) return { id: i, file, status: "rejected", reason: v.error, ext: v.ext };
    if (accepted >= MAX_BATCH_FILES) return { id: i, file, status: "rejected", reason: `Over the ${MAX_BATCH_FILES}-file batch limit.`, ext: v.ext };
    accepted++;
    return { id: i, file, status: "ready", reason: "", ext: v.ext, kind: v.kind };
  });
  return { items, ready: items.filter((x) => x.status === "ready"), rejected: items.filter((x) => x.status === "rejected") };
}

export function pageInfo(total, limit, offset) {
  const pages = Math.max(1, Math.ceil(total / limit)), page = Math.min(pages, Math.floor(offset / limit) + 1);
  return { page, pages, from: total ? offset + 1 : 0, to: Math.min(total, offset + limit) };
}
/** Page numbers to show, with "…" gaps: always first, last and `span` pages around the current one. */
export function pageWindow(page, pages, span = 1) {
  const out = [];
  for (let p = 1; p <= pages; p++) if (p === 1 || p === pages || Math.abs(p - page) <= span) out.push(p); else if (out[out.length - 1] !== "…") out.push("…");
  return out;
}

export const SORT_OPTIONS = [["newest", "Newest first"], ["oldest", "Oldest first"], ["score_desc", "Score: high to low"], ["score_asc", "Score: low to high"], ["words_desc", "Most words"], ["title", "Title A–Z"]];
export const SOURCE_OPTIONS = [["paste", "Pasted text"], ["pdf", "PDF"], ["docx", "DOCX"], ["txt", "TXT / MD"]];
export const SOURCE_LABEL = Object.fromEntries(SOURCE_OPTIONS);

/** History filters -> query parameters for GET /api/history/search (empty values are dropped). */
export function searchParams(f, limit = 10, page = 1) {
  const p = { limit, offset: (Math.max(1, page) - 1) * limit, sort: f.sort || "newest" };
  for (const k of ["q", "verdict", "source", "status", "date_from", "date_to"]) if (f[k]) p[k] = f[k];
  return p;
}
export const hasFilters = (f) => ["q", "verdict", "source", "status", "date_from", "date_to"].some((k) => !!f[k]);

/** UTC date strings (YYYY-MM-DD), because stored timestamps are UTC. days=null means all time. */
export function dateRange(days, now = new Date()) {
  if (days == null) return { date_from: "", date_to: "" };
  const to = new Date(now), from = new Date(now); from.setUTCDate(from.getUTCDate() - (days - 1));
  return { date_from: from.toISOString().slice(0, 10), date_to: to.toISOString().slice(0, 10) };
}
export function failureRate(batches) {
  const files = batches.reduce((a, b) => a + b.files, 0), failed = batches.reduce((a, b) => a + (b.summary.failed_files || 0), 0);
  return files ? failed / files : null;
}
