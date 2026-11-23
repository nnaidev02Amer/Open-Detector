// Thin fetch wrapper for the local API (same behaviour as the classic UI).
export async function api(path, opts) {
  let r;
  try { r = await fetch(path, opts); } catch (_) { throw new Error("Cannot reach the local server. Is it still running?"); }
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = typeof j.detail === "string" ? j.detail : msg; } catch (_) { /* keep status text */ }
    throw new Error(msg);
  }
  return r.json();
}
export const getStatus = () => api("/api/status");
export const getStats = () => api("/api/stats");
export const getModelInfo = () => api("/api/model-info");
export const searchHistory = (params) => api("/api/history/search?" + new URLSearchParams(params));
export const analyzeText = (text, title) =>
  api("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, title }) });
export const analyzeFile = (file, title) => {
  const fd = new FormData(); fd.append("file", file); if (title) fd.append("title", title);
  return api("/api/analyze-file", { method: "POST", body: fd });
};
export const recentHistory = (limit = 12) => api(`/api/history/search?limit=${limit}`);
export const getStatsFiltered = (params = {}) => api("/api/stats" + qs(params));
export const searchHistoryPage = (params = {}) => api("/api/history/search" + qs(params));
export const deleteAnalysis = (id) => api(`/api/history/${encodeURIComponent(id)}`, { method: "DELETE" });
export const analyzeBatch = (files, title) => {
  const fd = new FormData(); files.forEach((f) => fd.append("files", f)); if (title) fd.append("title", title);
  return api("/api/batch", { method: "POST", body: fd });
};
export const listBatches = () => api("/api/batch");
export const getBatch = (id) => api(`/api/batch/${encodeURIComponent(id)}`);
export const deleteBatch = (id) => api(`/api/batch/${encodeURIComponent(id)}`, { method: "DELETE" });
function qs(params) { const u = new URLSearchParams(); for (const [k, v] of Object.entries(params)) if (v !== "" && v != null) u.set(k, v); const s = u.toString(); return s ? "?" + s : ""; }
