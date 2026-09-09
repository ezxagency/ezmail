/* An in-memory stand-in for the Firestore compat API.

   It exists because every bug found by hand today lived in GLUE - the
   code between a decision and a write - and the suites only ever tested
   the decisions. A pure test cannot notice that a write goes to a
   collection with no document in it, or that a query returns nothing
   because a filter admits one type. This can.

   It is deliberately small and strict: it supports exactly the calls the
   app makes, and throws on anything else rather than quietly returning
   empty, because a fake that silently does nothing would reproduce the
   very class of bug it is here to catch. */

const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));

export function makeDb(){
  const store = new Map();               // "a/b/c" -> data
  const listeners = [];                  // { path, filters, cb }

  const seg = path => path.split("/").filter(Boolean);
  const colOf = path => { const p = seg(path); return p.slice(0, -1).join("/"); };

  const match = (data, filters) => filters.every(([field, op, val]) => {
    const v = field.split(".").reduce((o, k) => (o == null ? o : o[k]), data);
    if (op === "==") return v === val || (val === null && v === undefined);
    if (op === "!=") return v !== val;
    if (op === "<")  return v != null && v < val;
    if (op === "<=") return v != null && v <= val;
    if (op === ">")  return v != null && v > val;
    if (op === ">=") return v != null && v >= val;
    if (op === "array-contains") return Array.isArray(v) && v.indexOf(val) >= 0;
    throw new Error("fakedb: unsupported operator " + op);
  });

  const docsIn = (colPath, filters, group) => {
    const out = [];
    for (const [path, data] of store) {
      const p = seg(path);
      const inScope = group
        ? p.length >= 2 && p[p.length - 2] === colPath
        : colOf(path) === colPath;
      if (!inScope) continue;
      if (!match(data, filters)) continue;
      out.push(snapDoc(path, data));
    }
    return out;
  };

  const snapDoc = (path, data) => ({
    id: seg(path).pop(),
    exists: data !== undefined,
    data: () => clone(data),
    ref: { path, parent: { parent: { id: seg(path).slice(-3, -2)[0] || null } } }
  });

  const fire = () => listeners.forEach(l => {
    const docs = docsIn(l.path, l.filters, l.group);
    l.cb({ size: docs.length, empty: !docs.length, docs, forEach: f => docs.forEach(f) });
  });

  function docRef(path){
    return {
      path,
      id: seg(path).pop(),
      async get(){ return snapDoc(path, store.get(path)); },
      async set(data, opts){
        const prev = store.get(path);
        store.set(path, (opts && opts.merge && prev) ? Object.assign({}, prev, clone(data)) : clone(data));
        fire(); return undefined;
      },
      async update(patch){
        const prev = store.get(path);
        // THE POINT OF THIS FAKE: Firestore's update() fails on a document
        // that is not there, and a batch containing one fails entirely.
        if (prev === undefined) throw new Error("NOT_FOUND: no document to update at " + path);
        const next = Object.assign({}, prev);
        Object.keys(patch).forEach(k => {
          if (k.indexOf(".") < 0) { next[k] = clone(patch[k]); return; }
          const parts = k.split(".");
          let cur = next;
          parts.slice(0, -1).forEach(seg2 => { cur[seg2] = Object.assign({}, cur[seg2]); cur = cur[seg2]; });
          cur[parts[parts.length - 1]] = clone(patch[k]);
        });
        store.set(path, next); fire(); return undefined;
      },
      async delete(){ store.delete(path); fire(); return undefined; },
      collection(name){ return colRef(path + "/" + name); }
    };
  }

  function query(path, filters, group){
    return {
      where(f, op, v){ return query(path, filters.concat([[f, op, v]]), group); },
      limit(){ return query(path, filters, group); },
      orderBy(){ return query(path, filters, group); },
      async get(){
        const docs = docsIn(path, filters, group);
        return { size: docs.length, empty: !docs.length, docs, forEach: f => docs.forEach(f) };
      },
      onSnapshot(cb){
        const l = { path, filters, group, cb };
        listeners.push(l);
        Promise.resolve().then(() => {
          const docs = docsIn(path, filters, group);
          cb({ size: docs.length, empty: !docs.length, docs, forEach: f => docs.forEach(f) });
        });
        return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
      }
    };
  }

  function colRef(path){
    let n = 0;
    return Object.assign(query(path, [], false), {
      doc(id){ return docRef(path + "/" + (id || ("auto" + (++n) + "_" + Math.random().toString(36).slice(2, 8)))); },
      // the real one: a new auto-id document, written, its ref returned
      async add(data){ const ref = this.doc(); await ref.set(data); return ref; }
    });
  }

  return {
    _store: store,
    collection: colRef,
    collectionGroup(name){ return query(name, [], true); },
    batch(){
      const ops = [];
      return {
        set(ref, data, opts){ ops.push(() => ref.set(data, opts)); return this; },
        update(ref, patch){ ops.push(() => ref.update(patch)); return this; },
        delete(ref){ ops.push(() => ref.delete()); return this; },
        // all or nothing, like the real one: one bad update fails the lot
        async commit(){
          const undo = new Map();
          for (const [k, v] of store) undo.set(k, v);
          try { for (const op of ops) await op(); }
          catch (e) { store.clear(); for (const [k, v] of undo) store.set(k, v); throw e; }
          fire();
        }
      };
    },
    async runTransaction(fn){
      return fn({
        async get(ref){ return ref.get(); },
        set(ref, data){ return ref.set(data); },
        update(ref, patch){ return ref.update(patch); },
        delete(ref){ return ref.delete(); }
      });
    }
  };
}
