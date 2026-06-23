export type Doc = Record<string, unknown>;

export function getPath(doc: unknown, path: string): unknown {
  let cur: any = doc;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return 0;
}

function matchCondition(value: unknown, cond: unknown): boolean {
  if (cond && typeof cond === "object" && !Array.isArray(cond) && Object.keys(cond as Doc).some(k => k.startsWith("$"))) {
    for (const [op, arg] of Object.entries(cond as Doc)) {
      switch (op) {
        case "$eq": if (!eq(value, arg)) return false; break;
        case "$ne": if (eq(value, arg)) return false; break;
        case "$gt": if (!(compare(value, arg) > 0)) return false; break;
        case "$gte": if (!(compare(value, arg) >= 0)) return false; break;
        case "$lt": if (!(compare(value, arg) < 0)) return false; break;
        case "$lte": if (!(compare(value, arg) <= 0)) return false; break;
        case "$in": if (!Array.isArray(arg) || !arg.some(x => Array.isArray(value) ? value.some(v => eq(v, x)) : eq(value, x))) return false; break;
        case "$nin": if (Array.isArray(arg) && arg.some(x => Array.isArray(value) ? value.some(v => eq(v, x)) : eq(value, x))) return false; break;
        case "$exists": if ((value !== undefined) !== Boolean(arg)) return false; break;
        case "$regex": if (typeof value !== "string" || !new RegExp(String(arg), String((cond as Doc).$options ?? "")).test(value)) return false; break;
        case "$options": break;
        default: return false;
      }
    }
    return true;
  }
  if (Array.isArray(value) && !Array.isArray(cond)) return value.some(v => eq(v, cond));
  return eq(value, cond);
}

export function matchFilter(doc: Doc, filter?: Doc): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$and") {
      if (!Array.isArray(cond) || !cond.every(f => matchFilter(doc, f as Doc))) return false;
    } else if (key === "$or") {
      if (!Array.isArray(cond) || !cond.some(f => matchFilter(doc, f as Doc))) return false;
    } else if (key === "$nor") {
      if (Array.isArray(cond) && cond.some(f => matchFilter(doc, f as Doc))) return false;
    } else {
      if (!matchCondition(getPath(doc, key), cond)) return false;
    }
  }
  return true;
}

export function sortDocs(docs: Doc[], sort?: Record<string, 1 | -1>): Doc[] {
  if (!sort) return docs;
  return [...docs].sort((a, b) => {
    for (const [field, dir] of Object.entries(sort)) {
      const c = compare(getPath(a, field), getPath(b, field));
      if (c !== 0) return c * dir;
    }
    return 0;
  });
}

export function applyUpdate(original: Doc, update: Doc): { doc: Doc; modified: boolean } {
  const doc = structuredClone(original);
  const before = JSON.stringify(doc);
  const ops = Object.keys(update).some(k => k.startsWith("$")) ? update : { $set: update };
  const setPath = (path: string, value: unknown) => {
    const parts = path.split(".");
    let cur: any = doc;
    for (const p of parts.slice(0, -1)) cur = cur[p] ??= {};
    cur[parts.at(-1)!] = value;
  };
  const unsetPath = (path: string) => {
    const parts = path.split(".");
    let cur: any = doc;
    for (const p of parts.slice(0, -1)) { if (!cur?.[p]) return; cur = cur[p]; }
    delete cur[parts.at(-1)!];
  };
  for (const [op, fields] of Object.entries(ops)) {
    for (const [path, value] of Object.entries(fields as Doc)) {
      if (path === "_id") continue;
      if (op === "$set") setPath(path, value);
      else if (op === "$unset") unsetPath(path);
      else if (op === "$inc") setPath(path, Number(getPath(doc, path) ?? 0) + Number(value));
      else if (op === "$push") {
        const cur = getPath(doc, path);
        setPath(path, cur === undefined ? [value] : Array.isArray(cur) ? [...cur, value] : cur);
      } else if (op === "$pull") {
        const cur = getPath(doc, path);
        if (Array.isArray(cur)) setPath(path, cur.filter(v => !matchCondition(v, value)));
      } else throw new Error(`Unsupported update operator: ${op}`);
    }
  }
  return { doc, modified: JSON.stringify(doc) !== before };
}


export function projectDoc(doc: Doc, projection?: Record<string, 0 | 1>): Doc {
  if (!projection || Object.keys(projection).length === 0) return doc;
  const entries = Object.entries(projection).filter(([k]) => k !== "_id");
  const includeMode = entries.some(([, v]) => v === 1);
  const clone = structuredClone(doc);
  const out: Doc = {};
  const setPath = (target: Doc, path: string, value: unknown) => {
    const parts = path.split(".");
    let cur: any = target;
    for (const p of parts.slice(0, -1)) cur = cur[p] ??= {};
    cur[parts.at(-1)!] = value;
  };
  const unsetPath = (target: Doc, path: string) => {
    const parts = path.split(".");
    let cur: any = target;
    for (const p of parts.slice(0, -1)) { if (!cur?.[p]) return; cur = cur[p]; }
    delete cur[parts.at(-1)!];
  };
  if (includeMode) {
    for (const [field, mode] of entries) {
      if (mode !== 1) continue;
      const value = getPath(doc, field);
      if (value !== undefined) setPath(out, field, value);
    }
  } else {
    Object.assign(out, clone);
    for (const [field, mode] of entries) if (mode === 0) unsetPath(out, field);
  }
  if (projection._id === 0) delete out._id;
  else if (doc._id !== undefined) out._id = doc._id;
  return out;
}
