// Remembers which analysis Document Intelligence should open (tab-scoped, no data is stored here beyond an id).
import { api } from "./api.js";

const KEY = "od2-last-analysis";
export const lastId = () => { try { return sessionStorage.getItem(KEY); } catch (_) { return null; } };
export const setLastId = (id) => { try { sessionStorage.setItem(KEY, id); } catch (_) { /* private mode */ } };
export const loadAnalysis = (id) => api(`/api/history/${encodeURIComponent(id)}`);
