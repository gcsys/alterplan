/* alterplan · logique pure du planning de garde.
 *
 * Inspiré des « semaines dispo » de Trail Agrégateur : un rythme de base (alternance) et des
 * exceptions ponctuelles qui l'emportent sur le rythme. L'unité est le jour : chaque jour
 * appartient à un parent, « a » ou « b ». Une semaine ou un week-end n'est qu'un ensemble de jours.
 *
 * Données (data.json) :
 *   parents   : { a: {name, color}, b: {name, color} }
 *   rhythm    : { preset, first: "a"|"b", ref: "AAAA-MM-JJ" }
 *               ref = premier jour d'une période chez `first` (son jour de semaine donne le jour
 *               de bascule) ; pour « un week-end sur deux », un jour de la semaine dont le
 *               week-end est chez `first`.
 *   overrides : { "AAAA-MM-JJ": { w: "a"|"b", n?: "note" } }
 *
 * Aucune dépendance au DOM : testable sous Node (tests/planning.test.js). */
(function (root) {
  const DAY = 864e5;
  const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
  // Calculs en UTC : les changements d'heure ne décalent rien.
  const utc = (d) => {
    const [y, m, j] = d.split("-").map(Number);
    return Date.UTC(y, m - 1, j);
  };
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const addDays = (d, n) => iso(utc(d) + n * DAY);
  const diffDays = (a, b) => Math.round((utc(b) - utc(a)) / DAY);
  const dow = (d) => (new Date(utc(d)).getUTCDay() + 6) % 7; // 0 = lundi … 6 = dimanche
  const mondayOf = (d) => addDays(d, -dow(d));
  const todayIso = (now = new Date()) => iso(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const other = (w) => (w === "a" ? "b" : "a");
  const mod = (n, m) => ((n % m) + m) % m;

  /* Rythmes proposés. `days` : suite de jours, F = parent `first`, O = l'autre. `monday` : la
   * suite démarre le lundi de la semaine de ref (sinon le jour même de ref). */
  const PRESETS = {
    alt1: { label: "Une semaine sur deux", hint: "7 jours chacun, en alternance", days: "FFFFFFFOOOOOOO" },
    alt2: { label: "Deux semaines sur deux", hint: "14 jours chacun", days: "F".repeat(14) + "O".repeat(14) },
    r223: { label: "Rythme 2-2-3", hint: "pour les plus petits : 2 j, 2 j, 3 j", days: "FFOOFFFOOFFOOO" },
    we2: { label: "Un week-end sur deux", hint: "la semaine chez l'un, un week-end sur deux chez l'autre", days: "OOOOOFF" + "OOOOOOO", monday: true },
    none: { label: "Pas de rythme", hint: "tout se règle à la main", days: "O" },
  };

  const DEFAULT = {
    version: 1,
    parents: { a: { name: "Papa", color: "#0f8b8d" }, b: { name: "Maman", color: "#e76f51" } },
    rhythm: { preset: "alt1", first: "b", ref: "2026-11-16" },
    overrides: {},
  };

  const isW = (w) => w === "a" || w === "b";
  const color = (c, d) => (/^#[0-9a-f]{6}$/i.test(c || "") ? c : d);

  /* Données propres et complètes, quoi qu'on reçoive. */
  function clean(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const p = r.parents || {};
    const name = (x, d) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 24) : d);
    const rh = r.rhythm || {};
    const overrides = {};
    for (const [k, v] of Object.entries(r.overrides || {})) {
      if (!isIso(k) || !v || !isW(v.w)) continue;
      overrides[k] = v.n && String(v.n).trim() ? { w: v.w, n: String(v.n).trim().slice(0, 80) } : { w: v.w };
    }
    return {
      version: 1,
      parents: {
        a: { name: name(p.a && p.a.name, "Papa"), color: color(p.a && p.a.color, DEFAULT.parents.a.color) },
        b: { name: name(p.b && p.b.name, "Maman"), color: color(p.b && p.b.color, DEFAULT.parents.b.color) },
      },
      rhythm: {
        preset: PRESETS[rh.preset] ? rh.preset : "alt1",
        first: isW(rh.first) ? rh.first : "a",
        ref: isIso(rh.ref) ? rh.ref : DEFAULT.rhythm.ref,
      },
      overrides,
      events: cleanEvents(r.events),
      ...(r.updated ? { updated: String(r.updated) } : {}),
    };
  }

  /* ===== Événements : anniversaires (chaque année), trails, autres =====
   * { id, kind: "anniv" | "trail" | "event", title, date, end?, year? (naissance), who? ("a"|"b") } */
  const KINDS = {
    anniv: { label: "Anniversaire", icon: "🎂" },
    trail: { label: "Trail", icon: "🏃" },
    event: { label: "Événement", icon: "⭐" },
  };
  function cleanEvents(list) {
    const out = [];
    for (const e of Array.isArray(list) ? list : []) {
      if (!e || !isIso(e.date) || !KINDS[e.kind] || !String(e.title || "").trim()) continue;
      const ev = { id: String(e.id || "").slice(0, 24) || Math.random().toString(36).slice(2, 10), kind: e.kind, title: String(e.title).trim().slice(0, 60), date: e.date };
      if (e.kind !== "anniv" && isIso(e.end) && e.end > e.date && diffDays(e.date, e.end) < 60) ev.end = e.end;
      if (e.kind === "anniv" && /^\d{4}$/.test(String(e.year || ""))) ev.year = Number(e.year);
      if (isW(e.who)) ev.who = e.who;
      out.push(ev);
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  /* Date de l'anniversaire une année donnée (29 février -> 28 les autres années). */
  const annivIn = (e, y) => {
    const md = e.date.slice(5);
    return `${y}-${md === "02-29" && !leap(y) ? "02-28" : md}`;
  };
  /* Événements du jour d : [{...e, age?}] */
  function eventsOn(data, d) {
    const out = [];
    for (const e of data.events || []) {
      if (e.kind === "anniv") {
        const y = Number(d.slice(0, 4));
        if (annivIn(e, y) === d && (!e.year || y >= e.year)) out.push({ ...e, on: d, ...(e.year ? { age: y - e.year } : {}) });
      } else if (e.date <= d && d <= (e.end || e.date)) out.push({ ...e, on: d });
    }
    return out;
  }
  /* Prochaines occurrences à partir de d (événement en cours compris), triées. */
  function upcoming(data, from, n = 8) {
    const out = [];
    const y = Number(from.slice(0, 4));
    for (const e of data.events || []) {
      if (e.kind === "anniv") {
        let at = annivIn(e, y);
        if (at < from) at = annivIn(e, y + 1);
        const ay = Number(at.slice(0, 4));
        out.push({ ...e, on: at, ...(e.year ? { age: ay - e.year } : {}) });
      } else if ((e.end || e.date) >= from) out.push({ ...e, on: e.date });
    }
    return out.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0)).slice(0, n);
  }
  /* Recherche d'un événement par son titre : « anniversaire de Léo », « trail des Cévennes ». */
  function findEvent(data, q, from) {
    const s = norm(q).replace(/\b(anniversaire|anniv|de|du|des|d|la|le|les|quand|est|c est|l|trail|course)\b/g, " ").replace(/\s+/g, " ").trim();
    if (s.length < 2) return null;
    const hit = upcoming(data, from, 500).find((e) => norm(e.title).includes(s));
    return hit || null;
  }

  /* Le rythme seul : chez qui est ce jour ? */
  function base(data, d) {
    const { preset, first, ref } = data.rhythm;
    const P = PRESETS[preset] || PRESETS.alt1;
    const start = P.monday ? mondayOf(ref) : ref;
    const c = P.days[mod(diffDays(start, d), P.days.length)];
    return c === "F" ? first : other(first);
  }

  /* Chez qui est ce jour, exceptions comprises : {w, base, exc (exception posée), changed (diffère du rythme), note} */
  function day(data, d) {
    const b = base(data, d), o = data.overrides[d];
    return o ? { w: o.w, base: b, exc: true, changed: o.w !== b, note: o.n || "" } : { w: b, base: b, exc: false, changed: false, note: "" };
  }
  const who = (data, d) => day(data, d).w;

  /* Fixe des jours chez `w` (ou les rend au rythme si w = null). Une exception qui redit le rythme
   * n'est gardée que si elle porte une note. Renvoie de nouvelles données. */
  function setDays(data, days, w, note) {
    const overrides = { ...data.overrides };
    for (const d of days) {
      const b = base(data, d);
      const target = w || b;
      const n = note !== undefined ? note : (overrides[d] && overrides[d].n) || "";
      delete overrides[d];
      if (target !== b || (w && n)) overrides[d] = n ? { w: target, n } : { w: target };
    }
    return { ...data, overrides };
  }

  /* Inverser un ensemble de jours : tout passe chez l'autre parent que celui du premier jour. */
  function toggleDays(data, days) {
    if (!days.length) return data;
    const target = other(who(data, days[0]));
    const overrides = { ...data.overrides };
    for (const d of days) {
      const b = base(data, d), n = (overrides[d] && overrides[d].n) || "";
      delete overrides[d];
      if (target !== b || n) overrides[d] = n ? { w: target, n } : { w: target };
    }
    return { ...data, overrides };
  }

  const range = (from, to) => {
    const out = [];
    if (!isIso(from) || !isIso(to) || to < from) return out;
    for (let d = from; d <= to && out.length < 3700; d = addDays(d, 1)) out.push(d);
    return out;
  };
  const weekDays = (d) => range(mondayOf(d), addDays(mondayOf(d), 6));
  const weekendDays = (d) => [addDays(mondayOf(d), 5), addDays(mondayOf(d), 6)];

  /* Exceptions regroupées en périodes : jours consécutifs, même parent, même note. */
  function periods(data) {
    const keys = Object.keys(data.overrides).sort();
    const out = [];
    for (const d of keys) {
      const o = data.overrides[d], last = out[out.length - 1];
      if (last && addDays(last.to, 1) === d && last.w === o.w && last.n === (o.n || "")) last.to = d;
      else out.push({ from: d, to: d, w: o.w, n: o.n || "" });
    }
    return out.map((p) => ({ ...p, days: diffDays(p.from, p.to) + 1 }));
  }

  /* Prochain changement de parent après le jour d (le premier jour chez l'autre). */
  function nextSwitch(data, d, limit = 400) {
    const w = who(data, d);
    for (let i = 1; i <= limit; i++) {
      const x = addDays(d, i);
      if (who(data, x) !== w) return x;
    }
    return null;
  }
  /* Premier jour de la période en cours (jours consécutifs chez le même parent). */
  function periodStart(data, d, limit = 400) {
    const w = who(data, d);
    let x = d;
    for (let i = 0; i < limit && who(data, addDays(x, -1)) === w; i++) x = addDays(x, -1);
    return x;
  }

  /* Statistiques sur [from, to] : jours, week-ends (samedis), exceptions, détail par mois. */
  function stats(data, from, to) {
    const s = { total: 0, a: 0, b: 0, weA: 0, weB: 0, excA: 0, excB: 0, months: [] };
    let cur = null;
    for (const d of range(from, to)) {
      const x = day(data, d), ym = d.slice(0, 7);
      if (!cur || cur.ym !== ym) s.months.push((cur = { ym, a: 0, b: 0 }));
      s.total++; s[x.w]++; cur[x.w]++;
      if (dow(d) === 5) x.w === "a" ? s.weA++ : s.weB++;
      if (x.changed) x.w === "a" ? s.excA++ : s.excB++;
    }
    return s;
  }

  /* ===== Recherche en français : « 17 juin », « samedi », « du 10 au 15 août »… ===== */
  const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const MOIS_C = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’']/g, " ").replace(/([a-z])-(?=[a-z])/g, "$1 ").replace(/\s+/g, " ").trim();
  const MONTH_RX = [
    ["janv", 1], ["fev", 2], ["mars", 3], ["mar", 3], ["avr", 4], ["mai", 5], ["juin", 6],
    ["juil", 7], ["aou", 8], ["aout", 8], ["sep", 9], ["oct", 10], ["nov", 11], ["dec", 12],
  ];
  const monthOf = (w) => {
    for (const [p, m] of MONTH_RX) if (w.startsWith(p)) return m;
    return 0;
  };
  const valid = (y, m, d) => {
    const t = Date.UTC(y, m - 1, d), x = new Date(t);
    return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d ? iso(t) : null;
  };
  const NUM = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10 };

  /* Une date seule. Sans année : la prochaine occurrence (aujourd'hui compris). */
  function parseOne(txt, today, { after } = {}) {
    let s = norm(txt).replace(/^(le|la|l|ce|cette|au|du|jusqu au|jusqu a)\s+/, "").replace(/^(le|la|l)\s+/, "");
    if (!s) return null;
    const pivot = after || today;
    const future = (m, d, y) => {
      if (y) return valid(y < 100 ? 2000 + y : y, m, d);
      let yy = Number(pivot.slice(0, 4));
      let r = valid(yy, m, d);
      if (r && r < pivot) r = valid(yy + 1, m, d);
      if (!r && m === 2 && d === 29) for (let k = 1; k <= 4 && !r; k++) r = valid(yy + k, m, d);
      return r;
    };
    if (/^(aujourd hui|auj|ajd|maintenant|today)$/.test(s)) return today;
    if (/^(demain)$/.test(s)) return addDays(today, 1);
    if (/^(apres demain|apres-demain)$/.test(s)) return addDays(today, 2);
    if (/^hier$/.test(s)) return addDays(today, -1);
    if (/^noel$/.test(s)) return future(12, 25);
    if (/^(nouvel an|jour de l an)$/.test(s)) return future(1, 1);
    let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return valid(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?$/))) return future(+m[2], +m[1], m[3] ? +m[3] : 0);
    if ((m = s.match(/^(?:(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+)?(\d{1,2}|1er)(?:er)?\s+([a-z.]+)(?:\s+(\d{2,4}))?$/))) {
      const mo = monthOf(m[3]);
      if (!mo) return null;
      return future(mo, m[2] === "1er" ? 1 : +m[2], m[4] ? +m[4] : 0);
    }
    if ((m = s.match(/^(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)(?:\s+(prochain))?$/))) {
      const target = JOURS.indexOf(m[1]);
      let delta = mod(target - dow(pivot), 7);
      if (m[2] && delta === 0) delta = 7;
      return addDays(pivot, delta);
    }
    if ((m = s.match(/^dans\s+(\d+|[a-z]+)\s+(jours?|semaines?|mois)$/))) {
      const n = /^\d+$/.test(m[1]) ? +m[1] : NUM[m[1]];
      if (!n) return null;
      if (m[2].startsWith("jour")) return addDays(today, n);
      if (m[2].startsWith("sem")) return addDays(today, 7 * n);
      const x = D(today), mi = x.getUTCMonth() + n;
      const y = x.getUTCFullYear() + Math.floor(mi / 12), mo = mod(mi, 12) + 1;
      return valid(y, mo, Math.min(x.getUTCDate(), new Date(Date.UTC(y, mo, 0)).getUTCDate()));
    }
    return null;
  }

  /* Phrase libre -> {from, to} (to = from pour un seul jour), ou null. */
  function parse(txt, today = todayIso()) {
    let s = norm(txt)
      .replace(/[?!.,;]+/g, " ")
      .replace(/\b(est[- ]?ce que|suis[- ]?je|je suis|serai[- ]?je|dispo(nible)?s?|libre|les enfants|enfants|sont|chez qui|qui a|qui les a|on est|quel parent|garde)\b/g, " ")
      .replace(/\s+/g, " ").trim();
    if (!s) return null;
    let m;
    if (/^(ce|le) (week end|weekend|we)$/.test(s) || /^(week end|weekend)$/.test(s)) {
      const sat = addDays(mondayOf(today), 5);
      return { from: dow(today) === 6 ? today : sat, to: addDays(sat, 1), kind: "weekend" };
    }
    if (/^(le )?(week end|weekend|we) prochain$/.test(s) || /^le prochain (week end|weekend)$/.test(s)) {
      const sat = addDays(mondayOf(today), dow(today) >= 5 ? 12 : 5);
      return { from: sat, to: addDays(sat, 1), kind: "weekend" };
    }
    if (/^cette semaine$/.test(s)) return { from: mondayOf(today), to: addDays(mondayOf(today), 6), kind: "week" };
    if (/^la semaine prochaine$|^semaine prochaine$/.test(s)) {
      const mon = addDays(mondayOf(today), 7);
      return { from: mon, to: addDays(mon, 6), kind: "week" };
    }
    if ((m = s.match(/^(?:le )?(?:week end|weekend|we) (?:du )?(.+)$/))) {
      const d = parseOne(m[1], today);
      if (d) {
        const sat = dow(d) === 6 ? addDays(d, -1) : addDays(mondayOf(d), 5);
        return { from: sat, to: addDays(sat, 1), kind: "weekend" };
      }
    }
    if ((m = s.match(/^(?:la )?semaine du (.+)$/))) {
      const d = parseOne(m[1], today);
      if (d) return { from: mondayOf(d), to: addDays(mondayOf(d), 6), kind: "week" };
    }
    // Mois entier : « en août », « juillet 2027 »
    if ((m = s.match(/^(?:en |le mois d |le mois de |mois de )?([a-z]+)(?: (\d{4}))?$/)) && monthOf(m[1]) && !JOURS.includes(m[1])) {
      const mo = monthOf(m[1]);
      let y = m[2] ? +m[2] : Number(today.slice(0, 4));
      if (!m[2] && valid(y, mo, 1) < today.slice(0, 7) + "-01") y++;
      const from = valid(y, mo, 1);
      return { from, to: iso(Date.UTC(y, mo, 0)), kind: "month" };
    }
    // Plage : « du 10 au 15 août », « du 3/07 au 12/07 », « entre le 1er et le 5 mai »
    if ((m = s.match(/^(?:du|entre(?: le)?|de)\s+(.+?)\s+(?:au|et(?: le)?|a|jusqu au)\s+(.+)$/))) {
      let b = parseOne(m[2], today);
      let aTxt = m[1];
      // « du 10 au 15 août » : le mois (et l'année) du second bout s'appliquent au premier.
      if (/^(\d{1,2}|1er)$/.test(norm(aTxt)) && b) {
        const rest = norm(m[2]).replace(/^(le\s+)?(\d{1,2}|1er)\s*/, "");
        aTxt = `${aTxt} ${rest}`;
        let a = parseOne(aTxt, today);
        if (a && a > b) {
          // 25 au 3 janvier : le début est le mois d'avant
          const bd = new Date(utc(b));
          a = valid(bd.getUTCFullYear(), bd.getUTCMonth(), +norm(m[1]).replace("er", "")) ||
            valid(bd.getUTCFullYear() - 1, 12, +norm(m[1]).replace("er", ""));
        }
        if (a && b && a <= b) return { from: a, to: b, kind: "range" };
      }
      const a = parseOne(aTxt, today);
      if (a) {
        b = parseOne(m[2], today, { after: a });
        if (b && b >= a) return { from: a, to: b, kind: "range" };
      }
    }
    const d = parseOne(s, today);
    return d ? { from: d, to: d, kind: "day" } : null;
  }

  /* ===== Libellés ===== */
  const D = (d) => new Date(utc(d));
  const dayName = (d) => JOURS[dow(d)];
  const longDate = (d, { year } = {}) => {
    const x = D(d);
    const y = year === undefined ? x.getUTCFullYear() !== new Date().getFullYear() : year;
    return `${dayName(d)} ${x.getUTCDate() === 1 ? "1er" : x.getUTCDate()} ${MOIS[x.getUTCMonth()]}${y ? " " + x.getUTCFullYear() : ""}`;
  };
  const shortDate = (d) => `${D(d).getUTCDate()} ${MOIS_C[D(d).getUTCMonth()]}`;
  const rangeLabel = (a, b) => {
    if (a === b) return shortDate(a);
    const A = D(a), B = D(b);
    if (A.getUTCMonth() === B.getUTCMonth() && A.getUTCFullYear() === B.getUTCFullYear()) return `${A.getUTCDate()}–${shortDate(b)}`;
    return `${shortDate(a)} – ${shortDate(b)}`;
  };
  const monthTitle = (ym) => {
    const [y, m] = ym.split("-").map(Number);
    return `${MOIS[m - 1]} ${y}`;
  };

  root.Planning = {
    PRESETS, DEFAULT, MOIS, MOIS_C, JOURS,
    isIso, utc, iso, addDays, diffDays, dow, mondayOf, todayIso, other, range, weekDays, weekendDays,
    KINDS, cleanEvents, eventsOn, upcoming, findEvent,
    clean, base, day, who, setDays, toggleDays, periods, nextSwitch, periodStart, stats,
    parse, parseOne, norm, longDate, shortDate, rangeLabel, monthTitle, dayName,
  };
})(typeof window !== "undefined" ? window : globalThis);
