/* ============================================================
   Fake PostgREST builder para los tests del CRM (harness local).
   NO toca la base real: sirve datos en memoria y filtra como
   lo haría PostgREST (eq/is/in/not/or/lt/lte/gte).
   ============================================================ */
(function () {
  'use strict';

  function parseInList(raw) {
    if (Array.isArray(raw)) return raw;
    return String(raw || '')
      .replace(/^\(/, '').replace(/\)$/, '')
      .split(',')
      .map(function (s) { return s.trim().replace(/^"|"$/g, ''); })
      .filter(Boolean);
  }

  function cmp(a, b) {
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    var da = Date.parse(a), db = Date.parse(b);
    if (!isNaN(da) && !isNaN(db)) return da < db ? -1 : da > db ? 1 : 0;
    var na = Number(a), nb = Number(b);
    if (!isNaN(na) && !isNaN(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  }

  function matchCond(row, cond) {
    cond = String(cond || '').trim();
    if (!cond) return false;
    var m = cond.match(/^([a-zA-Z0-9_]+)\.([a-z]+)\.(.*)$/);
    if (!m) return false;
    var col = m[1], op = m[2], val = m[3];
    var cell = row[col];
    if (op === 'ilike' || op === 'like') {
      var needle = String(val).replace(/^%|%$/g, '').toLowerCase();
      return String(cell === null || cell === undefined ? '' : cell).toLowerCase().indexOf(needle) !== -1;
    }
    if (op === 'is') {
      var isVal = val === 'null' ? null : val.replace(/^"|"$/g, '');
      return (cell === null || cell === undefined ? null : cell) === isVal;
    }
    if (op === 'in') {
      var vals = parseInList(val.replace(/^\(/, '').replace(/\)$/, ''));
      return vals.indexOf(cell) !== -1;
    }
    if (op === 'eq') return cell === val.replace(/^"|"$/g, '');
    if (op === 'neq') return cell !== val.replace(/^"|"$/g, '');
    if (op === 'lt') return cmp(cell, val) < 0;
    if (op === 'lte') return cmp(cell, val) <= 0;
    if (op === 'gt') return cmp(cell, val) > 0;
    if (op === 'gte') return cmp(cell, val) >= 0;
    return false;
  }

  function applyFilter(rows, f) {
    switch (f.t) {
      case 'is': {
        var want = f.val === undefined ? null : f.val;
        return rows.filter(function (r) {
          var v = r[f.col];
          return (v === null || v === undefined ? null : v) === want;
        });
      }
      case 'not': {
        if (f.op === 'is') {
          var notWant = f.val === undefined ? null : f.val;
          return rows.filter(function (r) {
            var v = r[f.col];
            return (v === null || v === undefined ? null : v) !== notWant;
          });
        }
        if (f.op === 'in') {
          var vals = parseInList(f.val);
          return rows.filter(function (r) { return vals.indexOf(r[f.col]) === -1; });
        }
        return rows;
      }
      case 'eq': return rows.filter(function (r) { return r[f.col] === f.val; });
      case 'neq': return rows.filter(function (r) { return r[f.col] !== f.val; });
      case 'in': return rows.filter(function (r) { return (f.vals || []).indexOf(r[f.col]) !== -1; });
      case 'lt': return rows.filter(function (r) { return cmp(r[f.col], f.val) < 0; });
      case 'lte': return rows.filter(function (r) { return cmp(r[f.col], f.val) <= 0; });
      case 'gt': return rows.filter(function (r) { return cmp(r[f.col], f.val) > 0; });
      case 'gte': return rows.filter(function (r) { return cmp(r[f.col], f.val) >= 0; });
      case 'or': {
        var conds = String(f.cond || '').split(',');
        return rows.filter(function (r) {
          return conds.some(function (c) { return matchCond(r, c); });
        });
      }
      default: return rows;
    }
  }

  function makeQuery(table, rows, log) {
    var filters = [];
    var head = false, countMode = false, singleMode = false;
    var op = null, payload = null;
    var q = {
      select: function (cols, opts) {
        if (opts && opts.count) countMode = true;
        if (opts && opts.head) head = true;
        return q;
      },
      update: function (p) { op = 'update'; payload = p; return q; },
      insert: function (p) { op = 'insert'; payload = p; return q; },
      delete: function () { op = 'delete'; return q; },
      upsert: function (p) { op = 'upsert'; payload = p; return q; },
      is: function (col, val) { filters.push({ t: 'is', col: col, val: val }); return q; },
      not: function (col, op, val) { filters.push({ t: 'not', col: col, op: op, val: val }); return q; },
      eq: function (col, val) { filters.push({ t: 'eq', col: col, val: val }); return q; },
      neq: function (col, val) { filters.push({ t: 'neq', col: col, val: val }); return q; },
      or: function (cond) { filters.push({ t: 'or', cond: cond }); return q; },
      in: function (col, vals) { filters.push({ t: 'in', col: col, vals: vals || [] }); return q; },
      lt: function (col, val) { filters.push({ t: 'lt', col: col, val: val }); return q; },
      lte: function (col, val) { filters.push({ t: 'lte', col: col, val: val }); return q; },
      gt: function (col, val) { filters.push({ t: 'gt', col: col, val: val }); return q; },
      gte: function (col, val) { filters.push({ t: 'gte', col: col, val: val }); return q; },
      order: function () { return q; },
      range: function () { return q; },
      limit: function () { return q; },
      maybeSingle: function () { singleMode = true; return q; },
      single: function () { singleMode = true; return q; },
      then: function (resolve, reject) {
        if (op) {
          if (log) log.push({ op: op, table: table, payload: payload, filters: filters.slice() });
          return Promise.resolve({ data: null, error: null, count: null }).then(resolve, reject);
        }
        var out = (rows || []).slice();
        filters.forEach(function (f) { out = applyFilter(out, f); });
        if (log) log.push({ table: table, filters: filters.slice(), count: out.length });
        var total = out.length;
        var data = head ? [] : out;
        if (singleMode) {
          if (!total) {
            return Promise.resolve({ data: null, error: { message: 'No rows found' }, count: 0 }).then(resolve, reject);
          }
          data = data[0];
        }
        return Promise.resolve({ data: data, error: null, count: countMode ? total : null })
          .then(resolve, reject);
      }
    };
    return q;
  }

  window.__FAKE_PG = {
    install: function (data, log) {
      var store = data || {};
      var client = {
        from: function (table) {
          return makeQuery(table, store[table] || [], log);
        },
        auth: {
          getSession: function () { return Promise.resolve({ data: { session: null }, error: null }); },
          onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; }
        },
        channel: function () {
          return { on: function () { return this; }, subscribe: function () { return this; } };
        }
      };
      window.supabaseClient = client;
      return client;
    }
  };
})();
