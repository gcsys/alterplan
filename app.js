/* alterplan · interface. La logique est dans planning.js, le stockage dans storage.js. */
(function () {
  const P = window.Planning, S = window.Store, F = window.Feries;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* privé */ } },
  };

  const local = location.protocol === "file:" || /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname);
  const st = {
    data: P.clean(S.cached() || P.DEFAULT),
    me: LS.get("alterplan.me"),
    month: P.todayIso().slice(0, 7),
    scope: LS.get("alterplan.scope") || "week",
    mode: local ? "local" : "readonly", // "remote" | "readonly" | "local"
    reason: "",
    pending: [],
    saving: false,
    sync: "",
    showPast: false,
    statsPeriod: "year",
  };
  const today = () => P.todayIso();
  const name = (w) => st.data.parents[w].name;
  const canEdit = () => st.mode !== "readonly";

  /* ===== Couleurs des parents ===== */
  function applyColors() {
    const r = document.documentElement.style;
    r.setProperty("--pa", st.data.parents.a.color);
    r.setProperty("--pb", st.data.parents.b.color);
  }
  const pill = (w, txt = name(w)) => `<span class="who who-${w}"><i></i>${esc(txt)}</span>`;

  /* ===== Modifications ===== */
  let saveTimer = null;
  function commit(op, message, { undo, toastMsg } = {}) {
    st.data = P.clean(op(st.data));
    st.pending.push(op);
    render();
    if (toastMsg) toast(toastMsg, undo ? { label: "Annuler", fn: () => commit(undo, "Annulation") } : null);
    queueSave(message);
  }
  let lastMessage = "";
  function queueSave(message) {
    lastMessage = st.pending.length > 1 ? "Mise à jour du planning" : message;
    if (st.mode === "local") {
      S.cache(st.data);
      st.pending = [];
      return;
    }
    clearTimeout(saveTimer);
    setSync("pending");
    saveTimer = setTimeout(flush, 1200);
  }
  async function flush() {
    if (st.saving || !st.pending.length || st.mode !== "remote") return;
    st.saving = true;
    setSync("saving");
    const ops = st.pending.slice();
    try {
      const data = { ...st.data, updated: new Date().toISOString() };
      const saved = await S.save(data, lastMessage, (remote) => ops.reduce((d, op) => P.clean(op(d)), P.clean(remote)));
      st.pending = st.pending.slice(ops.length);
      if (!st.pending.length) {
        st.data = P.clean(saved);
        render();
      }
      setSync("ok");
    } catch (e) {
      if (e.status === 401) { st.pending = []; setSync("error", "Session expirée, reconnecte-toi."); return showAuth(); }
      setSync("error", e.message);
    } finally {
      st.saving = false;
      if (st.pending.length) saveTimer = setTimeout(flush, 800);
    }
  }
  window.addEventListener("beforeunload", (e) => {
    if (st.pending.length && st.mode === "remote") { e.preventDefault(); e.returnValue = ""; }
  });

  /* Remettre des jours tels qu'ils étaient (pour « Annuler »). */
  const restore = (days, prev) => (d) => {
    const overrides = { ...d.overrides };
    for (const x of days) prev[x] ? (overrides[x] = prev[x]) : delete overrides[x];
    return { ...d, overrides };
  };
  const snapshot = (days) => Object.fromEntries(days.map((x) => [x, st.data.overrides[x] || null]));

  function toggle(days, what) {
    if (!canEdit()) return askEdit();
    const prev = snapshot(days);
    const target = P.other(P.who(st.data, days[0]));
    const label = days.length === 1 ? P.longDate(days[0]) : `${what} du ${P.rangeLabel(days[0], days[days.length - 1])}`;
    commit((d) => P.toggleDays(d, days), `${label} : chez ${name(target)}`, {
      undo: restore(days, prev),
      toastMsg: `${label[0].toUpperCase() + label.slice(1)} → chez ${name(target)}`,
    });
  }
  function askEdit() {
    if (S.backend === "api") return showAuth("login");
    toast("Lecture seule sur cet appareil. Ajoute un jeton GitHub pour modifier.", { label: "Réglages", fn: () => openSettings("sec-share") });
  }

  /* ===== Synchro ===== */
  function setSync(state, msg = "") {
    st.sync = state;
    const el = $("#sync");
    const txt = {
      ok: "Enregistré",
      pending: "Modifié…",
      saving: "Enregistrement…",
      error: "Échec",
      readonly: "Lecture seule",
      local: "Local",
      loading: "Chargement…",
    }[state] || "";
    el.className = `sync ${state}`;
    el.textContent = txt;
    el.title = msg || (state === "readonly" ? "Ajoute un jeton GitHub dans les réglages pour modifier" : state === "local" ? "Les changements restent dans ce navigateur" : "");
    if (state === "error") toast(`Enregistrement impossible : ${msg}`, { label: "Réessayer", fn: flush });
  }

  /* ===== Toast ===== */
  let toastTimer;
  function toast(msg, action) {
    const t = $("#toast");
    t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ""}`;
    t.hidden = false;
    requestAnimationFrame(() => t.classList.add("on"));
    if (action) t.querySelector("button").onclick = () => { hide(); action.fn(); };
    clearTimeout(toastTimer);
    const hide = () => { t.classList.remove("on"); setTimeout(() => (t.hidden = true), 250); };
    toastTimer = setTimeout(hide, action ? 6000 : 3000);
  }

  /* ===== Bandeau « maintenant » ===== */
  function nextWeekend(w, from) {
    let sat = P.addDays(P.mondayOf(from), 5);
    if (sat < from && P.addDays(sat, 1) < from) sat = P.addDays(sat, 7);
    for (let i = 0; i < 60; i++, sat = P.addDays(sat, 7)) if (P.who(st.data, sat) === w && P.who(st.data, P.addDays(sat, 1)) === w) return sat;
    return null;
  }
  function nextVac() {
    const v = F.nextVacances(today())[0];
    if (!v) return "";
    const days = P.range(v.from, v.to), n = { a: 0, b: 0 };
    days.forEach((d) => n[P.who(st.data, d)]++);
    const inside = v.from <= today();
    const wait = P.diffDays(today(), v.from);
    return `<button type="button" class="vac-next" data-goto="${v.from}">
      <span class="lbl">${inside ? "En ce moment" : `Prochaines vacances · dans ${wait} jour${wait > 1 ? "s" : ""}`}</span>
      <strong>${esc(v.name)}</strong>
      <span class="vn-d">${P.rangeLabel(v.from, v.to)}</span>
      <span class="split"><i class="t-a" style="flex:${n.a}"></i><i class="t-b" style="flex:${n.b}"></i></span>
      <span class="vn-n"><b class="c-a">${esc(name("a"))} ${n.a} j</b> · <b class="c-b">${esc(name("b"))} ${n.b} j</b></span>
    </button>`;
  }
  function renderNow() {
    const t = today(), x = P.day(st.data, t), w = x.w;
    const sw = P.nextSwitch(st.data, t);
    const until = sw ? P.addDays(sw, -1) : null;
    const meLine = st.me === "a" || st.me === "b"
      ? (st.me === w
        ? `<span class="verdict with">Tu es avec les enfants</span>`
        : `<span class="verdict free">Tu es dispo</span>`)
      : "";
    let weeks = "";
    let mon = P.mondayOf(t);
    for (let i = 0; i < 8; i++, mon = P.addDays(mon, 7)) {
      const days = P.weekDays(mon).map((d) => `<i class="t-${P.who(st.data, d)}${d === t ? " now" : ""}"></i>`).join("");
      weeks += `<button type="button" class="wk" data-goto="${mon}"><span>${i === 0 ? "Cette sem." : P.shortDate(mon)}</span><span class="wk-bar">${days}</span></button>`;
    }
    let we = "";
    if (st.me === "a" || st.me === "b") {
      const free = nextWeekend(P.other(st.me), t), mine = nextWeekend(st.me, t);
      we = `<div class="we-next">
        ${free ? `<p><span class="lbl">Prochain week-end dispo</span><strong>${P.rangeLabel(free, P.addDays(free, 1))}</strong></p>` : ""}
        ${mine ? `<p><span class="lbl">Prochain week-end avec les enfants</span><strong>${P.rangeLabel(mine, P.addDays(mine, 1))}</strong></p>` : ""}
      </div>`;
    }
    $("#now").innerHTML = `
      <div class="now-main now-${w}">
        <p class="now-date">Aujourd'hui, ${P.longDate(t, { year: false })}</p>
        <p class="now-big">Les enfants sont chez <strong class="c-${w}">${esc(name(w))}</strong></p>
        <p class="now-sub">${until ? `jusqu'au ${P.longDate(until, { year: false })} · chez ${esc(name(P.other(w)))} à partir du ${P.longDate(sw, { year: false })}` : ""}
          ${x.note ? `<span class="note-tag">${esc(x.note)}</span>` : ""}</p>
        ${meLine}
      </div>
      <div class="now-side">
        <div class="weeks" aria-label="Les 8 prochaines semaines">${weeks}</div>
        ${we}
        ${nextVac()}
      </div>`;
  }

  /* ===== Recherche ===== */
  const SUGG = ["Ce week-end", "Semaine prochaine", "Vacances de Noël", "Du 10 au 15 août", "Le 17 juin"];
  function renderSuggest() {
    $("#suggest").innerHTML = SUGG.map((s) => `<button type="button" class="chip">${esc(s)}</button>`).join("");
  }
  /* Ce qui se passe un jour : événements, férié, vacances. */
  const evLabel = (e) => `${P.KINDS[e.kind].icon} ${e.kind === "anniv" ? `Anniversaire de ${e.title}${e.age != null ? ` (${e.age} an${e.age > 1 ? "s" : ""})` : ""}` : e.title}`;
  function dayExtras(d) {
    const out = P.eventsOn(st.data, d).map((e) => `<span class="ev-tag k-${e.kind}">${esc(evLabel(e))}${e.who ? ` · ${esc(name(e.who))}` : ""}</span>`);
    const f = F.ferie(d), v = F.vacances(d);
    if (f) out.push(`<span class="ev-tag ferie-tag">Férié · ${esc(f)}</span>`);
    if (v) out.push(`<span class="ev-tag vac-tag">${esc(v.name)}</span>`);
    return out.join("");
  }
  function answer(q) {
    const el = $("#answer");
    if (!q.trim()) { el.innerHTML = ""; el.className = "answer"; return; }
    let r = null, found = null;
    const vac = F.findVacances(q, today());
    if (vac) r = { from: vac.from, to: vac.to, kind: "vac", title: `${vac.name} ${vac.from.slice(0, 4)}${vac.to.slice(0, 4) !== vac.from.slice(0, 4) ? "-" + vac.to.slice(0, 4) : ""}` };
    if (!r) r = P.parse(q, today());
    if (!r && (found = P.findEvent(st.data, q, today()))) {
      r = { from: found.on, to: found.kind === "anniv" ? found.on : found.end || found.on, kind: "event", title: evLabel(found) };
    }
    if (!r) {
      el.className = "answer miss";
      el.innerHTML = `<p>Je n'ai pas reconnu de date. Essaie « 17 juin », « samedi », « ce week-end », « du 10 au 15 août », « vacances de Noël » ou le nom d'un événement.</p>`;
      return;
    }
    const days = P.range(r.from, r.to);
    const info = days.map((d) => P.day(st.data, d));
    const me = st.me === "a" || st.me === "b" ? st.me : null;
    const goto = `<button type="button" class="link-btn" data-goto="${r.from}">Voir dans le calendrier →</button>`;
    if (days.length === 1) {
      const x = info[0], d = days[0];
      const start = P.periodStart(st.data, d), sw = P.nextSwitch(st.data, d);
      const verdict = me ? (x.w === me ? `<span class="verdict with">Non, tu as les enfants</span>` : `<span class="verdict free">Oui, tu es dispo</span>`) : "";
      const extras = dayExtras(d);
      el.className = `answer hit ans-${x.w}`;
      el.innerHTML = `
        <div class="ans-date"><span class="ans-dow">${P.dayName(d)}</span><span class="ans-num">${new Date(P.utc(d)).getUTCDate()}</span><span class="ans-mon">${P.MOIS[new Date(P.utc(d)).getUTCMonth()]} ${d.slice(0, 4)}</span></div>
        <div class="ans-body">
          ${r.kind === "event" ? `<p class="ans-title">${esc(r.title)}</p>` : ""}
          ${verdict}
          <p class="ans-who">Les enfants sont chez <strong class="c-${x.w}">${esc(name(x.w))}</strong>${x.changed ? ` <span class="note-tag">exception</span>` : ""}${x.note ? ` <span class="note-tag">${esc(x.note)}</span>` : ""}</p>
          ${extras ? `<p class="ans-ev">${extras}</p>` : ""}
          <p class="muted">Du ${P.longDate(start)} au ${sw ? P.longDate(P.addDays(sw, -1)) : "…"}.</p>
          ${goto}
        </div>`;
      return;
    }
    const n = { a: 0, b: 0 };
    info.forEach((x) => n[x.w]++);
    const strip = days.map((d, i) => {
      const evs = P.eventsOn(st.data, d), f = F.ferie(d);
      const tip = `${P.longDate(d)} : ${name(info[i].w)}${evs.length ? " · " + evs.map(evLabel).join(", ") : ""}${f ? " · " + f : ""}`;
      return `<span class="sd t-${info[i].w}${f ? " ferie" : ""}" title="${esc(tip)}"><b>${P.JOURS[P.dow(d)][0].toUpperCase()}</b>${new Date(P.utc(d)).getUTCDate()}${evs.length ? `<i>${evs.map((e) => P.KINDS[e.kind].icon).join("")}</i>` : ""}</span>`;
    }).join("");
    let verdict = "";
    if (me) {
      const free = days.filter((d, i) => info[i].w !== me);
      verdict = free.length === days.length ? `<span class="verdict free">Oui, tu es dispo tout du long</span>`
        : !free.length ? `<span class="verdict with">Non, tu as les enfants tout du long</span>`
        : `<span class="verdict part">Dispo ${free.length} jour${free.length > 1 ? "s" : ""} sur ${days.length}</span>`;
    }
    const evs = [];
    days.forEach((d) => P.eventsOn(st.data, d).forEach((e) => { if (!evs.some((x) => x.id === e.id)) evs.push(e); }));
    const title = r.title ? `${r.title}, du ${P.longDate(r.from)} au ${P.longDate(r.to)}`
      : r.kind === "weekend" ? `Week-end du ${P.rangeLabel(r.from, r.to)}` : r.kind === "week" ? `Semaine du ${P.rangeLabel(r.from, r.to)}` : r.kind === "month" ? P.monthTitle(r.from.slice(0, 7)) : `Du ${P.longDate(r.from)} au ${P.longDate(r.to)}`;
    el.className = "answer hit range";
    el.innerHTML = `
      <div class="ans-body">
        <p class="ans-title">${esc(title[0].toUpperCase() + title.slice(1))}</p>
        ${verdict}
        <p class="ans-who">${n.a ? `${pill("a")} ${n.a} j` : ""} ${n.b ? `${pill("b")} ${n.b} j` : ""}</p>
        <div class="strip${days.length > 16 ? " dense" : ""}">${strip}</div>
        ${evs.length && days.length <= 62 ? `<p class="ans-ev">${evs.map((e) => `<span class="ev-tag k-${e.kind}">${esc(evLabel(e))} · ${P.shortDate(e.on)}</span>`).join("")}</p>` : ""}
        ${goto}
      </div>`;
  }

  /* ===== Calendrier ===== */
  function renderCal() {
    const [y, m] = st.month.split("-").map(Number);
    $("#cal-h").textContent = P.monthTitle(st.month);
    const first = `${st.month}-01`, last = P.iso(Date.UTC(y, m, 0)), t = today();
    let html = `<div class="c-head" aria-hidden="true"><span class="c-days">${["L", "M", "M", "J", "V", "S", "D"].map((d, i) => `<span${i >= 5 ? ' class="we"' : ""}>${d}</span>`).join("")}</span><span></span></div>`;
    for (let mon = P.mondayOf(first); mon <= last; mon = P.addDays(mon, 7)) {
      const days = P.weekDays(mon), info = days.map((d) => P.day(st.data, d));
      const cnt = { a: 0, b: 0 };
      info.forEach((x) => cnt[x.w]++);
      const notes = [...new Set(info.map((x) => x.note).concat(days.map((d) => (F.vacances(d) || {}).name)).filter(Boolean))];
      const cells = days.map((d, i) => {
        const x = info[i], out = d.slice(0, 7) !== st.month;
        const prevW = i > 0 ? info[i - 1].w : P.who(st.data, P.addDays(d, -1));
        const evs = P.eventsOn(st.data, d), f = F.ferie(d), v = F.vacances(d);
        const lbl = `${P.longDate(d)} : chez ${name(x.w)}${x.changed ? " (exception)" : ""}${x.note ? `, ${x.note}` : ""}${evs.length ? ". " + evs.map(evLabel).join(", ") : ""}${f ? `. Férié : ${f}` : ""}${v ? `. ${v.name}` : ""}`;
        return `<button type="button" class="d t-${x.w}${i >= 5 ? " we" : ""}${out ? " out" : ""}${d === t ? " today" : ""}${x.changed ? " exc" : ""}${x.note ? " noted" : ""}${prevW !== x.w ? " swp" : ""}${v ? " vac" : ""}${f ? " ferie" : ""}" data-day="${d}" aria-label="${esc(lbl)}" title="${esc(lbl)}"><span class="dn">${new Date(P.utc(d)).getUTCDate()}</span>${evs.length ? `<span class="dev">${evs.slice(0, 3).map((e) => P.KINDS[e.kind].icon).join("")}</span>` : ""}</button>`;
      }).join("");
      const summary = cnt.a === 7 || cnt.b === 7
        ? pill(cnt.a === 7 ? "a" : "b")
        : `<span class="split"><i class="t-a" style="flex:${cnt.a}"></i><i class="t-b" style="flex:${cnt.b}"></i></span><small>${esc(name("a"))} ${cnt.a} · ${esc(name("b"))} ${cnt.b}</small>`;
      html += `<div class="c-row" data-week="${mon}"><span class="c-days">${cells}</span><span class="c-st">${summary}${notes.length ? `<small class="c-note" title="${esc(notes.join(", "))}">${esc(notes.join(", "))}</small>` : ""}</span></div>`;
    }
    const grid = $("#cal-grid");
    grid.innerHTML = html;
    grid.dataset.scope = st.scope;
    grid.classList.toggle("ro", !canEdit());
    $$("#cal-tools .seg button").forEach((b) => {
      const on = b.dataset.scope === st.scope;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", on);
    });
    $("#cal-hint").textContent = canEdit()
      ? { week: "Touche une semaine pour la passer chez l'autre parent.", weekend: "Touche une ligne pour inverser son week-end.", day: "Touche un jour pour l'inverser." }[st.scope]
      : "Lecture seule : ajoute un jeton GitHub dans les réglages pour modifier.";
  }
  function renderLegend() {
    $("#legend").innerHTML = `<li>${pill("a")}</li><li>${pill("b")}</li><li><span class="lg-exc"></span>Exception</li><li><span class="lg-today"></span>Aujourd'hui</li><li><span class="lg-vac"></span>Vacances scolaires (zone C)</li><li><span class="lg-ferie"></span>Jour férié</li><li>🎂 🏃 ⭐ Événements</li>`;
  }

  /* ===== Exceptions ===== */
  function renderExc() {
    const t = today();
    const all = P.periods(st.data);
    const up = all.filter((p) => p.to >= t), past = all.filter((p) => p.to < t).reverse();
    const item = (p) => `
      <li class="ex-item ex-${p.w}" data-from="${p.from}" data-to="${p.to}">
        <span class="ex-bar"></span>
        <div class="ex-main">
          <p class="ex-dates">${p.from === p.to ? P.longDate(p.from) : `${P.longDate(p.from)} → ${P.longDate(p.to)}`}</p>
          <p class="ex-meta">${pill(p.w)} <span class="muted">${p.days} jour${p.days > 1 ? "s" : ""}</span>${p.n ? ` · <span class="ex-note">${esc(p.n)}</span>` : ""}</p>
        </div>
        ${canEdit() ? `<div class="ex-act">
          <button type="button" class="icon-btn sm" data-act="note" aria-label="Modifier la note"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
          <button type="button" class="icon-btn sm" data-act="del" aria-label="Supprimer l'exception"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>` : ""}
      </li>`;
    const list = (st.showPast ? up.concat(past) : up);
    $("#exc-list").innerHTML = list.length ? list.map(item).join("") : `<li class="empty">Aucune exception à venir. Touche le calendrier ou « + Ajouter » pour en créer une.</li>`;
    const pb = $("#exc-past");
    pb.hidden = !past.length;
    pb.textContent = st.showPast ? "Masquer les exceptions passées" : past.length > 1 ? `Voir les ${past.length} exceptions passées` : "Voir l'exception passée";
    $("#add-exc").hidden = !canEdit();
  }

  /* ===== Événements ===== */
  function renderEvents() {
    const t = today();
    const list = P.upcoming(st.data, t, st.showAllEv ? 200 : 6);
    const total = P.upcoming(st.data, t, 200).length;
    $("#ev-list").innerHTML = list.length ? list.map((e) => {
      const w = P.who(st.data, e.on), wait = P.diffDays(t, e.on);
      const when = wait <= 0 ? "aujourd'hui" : wait === 1 ? "demain" : `dans ${wait} j`;
      return `<li class="ev-item k-${e.kind}" data-id="${esc(e.id)}">
        <span class="ev-ico" aria-hidden="true">${P.KINDS[e.kind].icon}</span>
        <div class="ex-main">
          <p class="ex-dates">${esc(e.kind === "anniv" ? e.title : e.title)}${e.age != null ? ` <span class="muted">${e.age} an${e.age > 1 ? "s" : ""}</span>` : ""}${e.who ? ` ${pill(e.who)}` : ""}</p>
          <p class="ex-meta"><span>${e.end && e.kind !== "anniv" ? `${P.rangeLabel(e.date, e.end)}` : P.longDate(e.on)}</span><span class="muted">· ${when} ·</span>${pill(w, `enfants chez ${name(w)}`)}</p>
        </div>
        ${canEdit() ? `<div class="ex-act">
          <button type="button" class="icon-btn sm" data-act="edit" aria-label="Modifier"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
          <button type="button" class="icon-btn sm" data-act="del" aria-label="Supprimer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>` : ""}
      </li>`;
    }).join("") : `<li class="empty">Aucun événement. Ajoute des anniversaires (rappel chaque année), des trails ou d'autres dates.</li>`;
    const more = $("#ev-more");
    more.hidden = total <= 6;
    more.textContent = st.showAllEv ? "Afficher moins" : `Voir les ${total} événements`;
    $("#add-ev").hidden = !canEdit();
  }

  /* ===== Statistiques ===== */
  function periodRange() {
    const t = today(), y = Number(t.slice(0, 4)), sy = t.slice(5) >= "09-01" ? y : y - 1;
    switch (st.statsPeriod) {
      case "school": return [`${sy}-09-01`, `${sy + 1}-08-31`];
      case "last12": return [P.addDays(t, -364), t];
      case "next12": return [t, P.addDays(t, 364)];
      case "nextyear": return [`${y + 1}-01-01`, `${y + 1}-12-31`];
      case "custom": {
        const a = $("#st-from").value, b = $("#st-to").value;
        return P.isIso(a) && P.isIso(b) && a <= b ? [a, b] : [`${y}-01-01`, `${y}-12-31`];
      }
      default: return [`${y}-01-01`, `${y}-12-31`];
    }
  }
  function renderStatsOptions() {
    const t = today(), y = Number(t.slice(0, 4)), sy = t.slice(5) >= "09-01" ? y : y - 1;
    const sel = $("#stats-period");
    sel.innerHTML = [["year", `Année ${y}`], ["school", `Année scolaire ${sy}-${sy + 1}`], ["last12", "12 derniers mois"], ["next12", "12 prochains mois"], ["nextyear", `Année ${y + 1}`], ["custom", "Personnalisée…"]]
      .map(([v, l]) => `<option value="${v}"${v === st.statsPeriod ? " selected" : ""}>${l}</option>`).join("");
  }
  function renderStats() {
    const [from, to] = periodRange();
    $("#stats-custom").hidden = st.statsPeriod !== "custom";
    const s = P.stats(st.data, from, to);
    s.vacA = s.vacB = s.ferA = s.ferB = 0;
    for (const d of P.range(from, to)) {
      const w = P.who(st.data, d);
      if (F.vacances(d)) w === "a" ? s.vacA++ : s.vacB++;
      if (F.ferie(d)) w === "a" ? s.ferA++ : s.ferB++;
    }
    const pa = s.total ? Math.round((s.a / s.total) * 1000) / 10 : 0, pb = Math.round((100 - pa) * 10) / 10;
    const diff = s.a - s.b;
    const max = Math.max(...s.months.map((m) => m.a + m.b), 1);
    const months = s.months.map((m) => {
      const [yy, mm] = m.ym.split("-").map(Number);
      return `<li><span class="m-l">${P.MOIS_C[mm - 1]}${s.months.length > 12 || yy !== Number(from.slice(0, 4)) && mm === 1 ? ` <small>${String(yy).slice(2)}</small>` : ""}</span>
        <span class="m-bar" style="--w:${((m.a + m.b) / max) * 100}%"><i class="t-a" style="flex:${m.a}"></i><i class="t-b" style="flex:${m.b}"></i></span>
        <span class="m-n"><b class="c-a">${m.a}</b> / <b class="c-b">${m.b}</b></span></li>`;
    }).join("");
    $("#stats-body").innerHTML = `
      <p class="muted small">Du ${P.longDate(from, { year: true })} au ${P.longDate(to, { year: true })} · ${s.total} jours</p>
      <div class="big-split">
        <div class="bs-bar"><i class="t-a" style="flex:${s.a || 0.0001}"></i><i class="t-b" style="flex:${s.b || 0.0001}"></i></div>
        <div class="bs-leg">
          <p><span class="bs-pct c-a">${pa.toLocaleString("fr-FR")} %</span><span class="bs-n">${s.a} jours chez ${esc(name("a"))}</span></p>
          <p class="r"><span class="bs-pct c-b">${pb.toLocaleString("fr-FR")} %</span><span class="bs-n">${s.b} jours chez ${esc(name("b"))}</span></p>
        </div>
      </div>
      <div class="tiles">
        <div class="tile"><span class="lbl">Week-ends</span><span class="val"><b class="c-a">${s.weA}</b> / <b class="c-b">${s.weB}</b></span></div>
        <div class="tile"><span class="lbl">Jours en exception</span><span class="val"><b class="c-a">${s.excA}</b> / <b class="c-b">${s.excB}</b></span></div>
        <div class="tile"><span class="lbl">Vacances scolaires</span><span class="val"><b class="c-a">${s.vacA}</b> / <b class="c-b">${s.vacB}</b></span></div>
        <div class="tile"><span class="lbl">Jours fériés</span><span class="val"><b class="c-a">${s.ferA}</b> / <b class="c-b">${s.ferB}</b></span></div>
        <div class="tile"><span class="lbl">Écart</span><span class="val">${diff === 0 ? "Équilibre parfait" : `<b class="c-${diff > 0 ? "a" : "b"}">${esc(name(diff > 0 ? "a" : "b"))}</b> +${Math.abs(diff)} j`}</span></div>
      </div>
      <ul class="months">${months}</ul>`;
  }

  /* ===== En-tête ===== */
  function renderMe() {
    const b = $("#me-btn");
    b.innerHTML = st.me === "a" || st.me === "b" ? `${pill(st.me, `Je suis ${name(st.me)}`)}` : `<span class="who"><i></i>Qui suis-je ?</span>`;
  }

  function render() {
    applyColors();
    renderMe();
    renderNow();
    renderCal();
    renderLegend();
    renderExc();
    renderEvents();
    renderStats();
    answer($("#q").value);
    if (dlgSet.open) renderSettings(false);
  }

  /* ===== Réglages ===== */
  const dlgSet = $("#dlg-set");
  const SWATCHES = ["#0f8b8d", "#2f6fde", "#6d5bd0", "#2e9d5b", "#e76f51", "#d6457a", "#e0a106", "#5f6b73"];
  function renderSettings(full = true) {
    const d = st.data;
    if (full) {
      $("#parents-edit").innerHTML = ["a", "b"].map((w) => `
        <div class="pe" data-w="${w}">
          <input type="text" value="${esc(d.parents[w].name)}" maxlength="24" aria-label="Nom du parent ${w === "a" ? 1 : 2}" ${canEdit() ? "" : "disabled"}>
          <div class="sw">${SWATCHES.map((c) => `<button type="button" style="--c:${c}" data-c="${c}" aria-label="Couleur ${c}" ${canEdit() ? "" : "disabled"}></button>`).join("")}</div>
        </div>`).join("");
    }
    $$("#parents-edit .pe").forEach((el) => {
      $$(".sw button", el).forEach((b) => b.classList.toggle("on", b.dataset.c === d.parents[el.dataset.w].color));
    });
    $("#presets").innerHTML = Object.entries(P.PRESETS).map(([k, p]) => `
      <button type="button" role="radio" aria-checked="${k === d.rhythm.preset}" class="preset${k === d.rhythm.preset ? " on" : ""}" data-p="${k}" ${canEdit() ? "" : "disabled"}>
        <span class="pr-l">${esc(p.label)}</span><span class="pr-h">${esc(p.hint)}</span>
      </button>`).join("");
    const pr = P.PRESETS[d.rhythm.preset];
    $("#rh-ref").hidden = d.rhythm.preset === "none";
    $("#rh-ref-lbl").textContent = pr.monday ? "Le week-end chez" : "Une période chez";
    $("#rh-ref-lbl2").textContent = pr.monday ? "tombe la semaine du" : "commence le";
    $("#rh-first").innerHTML = ["a", "b"].map((w) => `<button type="button" role="radio" aria-checked="${d.rhythm.first === w}" class="${d.rhythm.first === w ? "on " : ""}wp-${w}" data-w="${w}" ${canEdit() ? "" : "disabled"}>${esc(name(w))}</button>`).join("");
    $("#rh-date").value = d.rhythm.ref;
    $("#rh-date").disabled = !canEdit();
    $("#rh-help").textContent = d.rhythm.preset === "none"
      ? `Sans rythme, tous les jours sont chez ${name(P.other(d.rhythm.first))} sauf exceptions.`
      : pr.monday ? "Choisis n'importe quel jour de la semaine dont le week-end est concerné." : `Le jour de la semaine de cette date devient le jour d'échange (${P.dayName(d.rhythm.ref)}).`;
    let prev = "", mon = P.mondayOf(today());
    for (let i = 0; i < 4; i++, mon = P.addDays(mon, 7)) {
      prev += `<div class="pv"><span>${P.shortDate(mon)}</span><span class="wk-bar">${P.weekDays(mon).map((x) => `<i class="t-${P.base(d, x)}"></i>`).join("")}</span></div>`;
    }
    $("#rh-preview").innerHTML = prev;

    $("#repo-name").textContent = S.repo;
    $("#share-state").innerHTML = st.mode === "remote"
      ? `<span class="ok">✓ Modification activée.</span> Chaque changement est enregistré dans <code>data.json</code> du repo <a href="https://github.com/${esc(S.repo)}" target="_blank" rel="noopener">${esc(S.repo)}</a>, visible par l'autre parent.`
      : st.mode === "local"
        ? "Mode local : les changements restent dans ce navigateur."
        : `Lecture seule sur cet appareil.${st.reason ? ` <span class="err">${esc(st.reason)}</span>` : ""} Colle un jeton GitHub pour pouvoir modifier le planning.`;
    $("#token-clear").hidden = !S.token();
    $("#token").value = "";
    $("#token").placeholder = S.token() ? "Jeton enregistré sur cet appareil" : "github_pat_…";
  }
  function openSettings(section) {
    renderSettings();
    renderAccount();
    dlgSet.showModal();
    if (section) document.getElementById(section)?.scrollIntoView({ block: "start" });
  }

  /* ===== Fichiers ===== */
  function download(name, type, content) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function ics() {
    const from = P.addDays(today(), -92), to = P.addDays(today(), 548);
    const ev = [];
    let start = from, w = P.who(st.data, from);
    const fmt = (d) => d.replace(/-/g, "");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    const push = (a, b, who) => ev.push(["BEGIN:VEVENT", `UID:${fmt(a)}-${who}@alterplan`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${fmt(a)}`, `DTEND;VALUE=DATE:${fmt(P.addDays(b, 1))}`, `SUMMARY:Enfants chez ${name(who).replace(/[,;\\]/g, " ")}`, "TRANSP:TRANSPARENT", "END:VEVENT"].join("\r\n"));
    for (let d = P.addDays(from, 1); d <= to; d = P.addDays(d, 1)) {
      const x = P.who(st.data, d);
      if (x !== w) { push(start, P.addDays(d, -1), w); start = d; w = x; }
    }
    push(start, to, w);
    for (const e of st.data.events) {
      const base = ["BEGIN:VEVENT", `UID:${e.id}@alterplan`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${fmt(e.date)}`,
        `DTEND;VALUE=DATE:${fmt(P.addDays(e.kind === "anniv" ? e.date : e.end || e.date, 1))}`,
        `SUMMARY:${(e.kind === "anniv" ? `Anniversaire de ${e.title}` : e.title).replace(/[,;\\]/g, " ")}`];
      if (e.kind === "anniv") base.push("RRULE:FREQ=YEARLY");
      ev.push([...base, "END:VEVENT"].join("\r\n"));
    }
    download("alterplan.ics", "text/calendar", ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//alterplan//FR", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Garde des enfants", ...ev, "END:VCALENDAR"].join("\r\n") + "\r\n");
  }

  /* ===== Événements ===== */
  function gotoDate(d) {
    st.month = d.slice(0, 7);
    renderCal();
    $(".cal").scrollIntoView({ behavior: "smooth", block: "start" });
    const cell = $(`.d[data-day="${d}"]`);
    if (cell) { cell.classList.add("flash"); setTimeout(() => cell.classList.remove("flash"), 1600); }
  }
  function shiftMonth(n) {
    const [y, m] = st.month.split("-").map(Number);
    st.month = P.iso(Date.UTC(y, m - 1 + n, 1)).slice(0, 7);
    renderCal();
  }

  function bind() {
    $("#prev").onclick = () => shiftMonth(-1);
    $("#next").onclick = () => shiftMonth(1);
    $("#today-btn").onclick = () => { st.month = today().slice(0, 7); renderCal(); };
    $("#cal-tools .seg").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-scope]");
      if (!b) return;
      st.scope = b.dataset.scope;
      LS.set("alterplan.scope", st.scope);
      renderCal();
    });
    $("#cal-grid").addEventListener("click", (e) => {
      const cell = e.target.closest(".d");
      const row = e.target.closest(".c-row");
      if (!row) return;
      const mon = row.dataset.week;
      if (st.scope === "week") toggle(P.weekDays(mon), "semaine");
      else if (st.scope === "weekend") toggle(P.weekendDays(mon), "week-end");
      else if (cell) toggle([cell.dataset.day]);
    });
    // Glisser pour changer de mois
    let x0 = null, y0 = null;
    const grid = $("#cal-grid");
    grid.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    grid.addEventListener("touchend", (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) shiftMonth(dx < 0 ? 1 : -1);
      x0 = null;
    });
    document.addEventListener("keydown", (e) => {
      if (e.target.closest("input, textarea, select, dialog")) return;
      if (e.key === "ArrowLeft") shiftMonth(-1);
      if (e.key === "ArrowRight") shiftMonth(1);
      if (e.key === "/") { e.preventDefault(); $("#q").focus(); }
    });

    document.addEventListener("click", (e) => {
      const g = e.target.closest("[data-goto]");
      if (g) gotoDate(g.dataset.goto);
    });

    // Recherche
    let qt;
    $("#q").addEventListener("input", () => { clearTimeout(qt); qt = setTimeout(() => answer($("#q").value), 180); });
    $("#search-form").addEventListener("submit", (e) => { e.preventDefault(); answer($("#q").value); $("#q").blur(); });
    $("#suggest").addEventListener("click", (e) => {
      const b = e.target.closest(".chip");
      if (!b) return;
      $("#q").value = b.textContent;
      answer(b.textContent);
    });

    // Qui suis-je
    const dlgMe = $("#dlg-me");
    $("#me-btn").onclick = () => {
      $("#me-choices").innerHTML = ["a", "b"].map((w) => `<button value="${w}" class="me-c me-${w}"><i></i>${esc(name(w))}</button>`).join("");
      dlgMe.showModal();
    };
    dlgMe.addEventListener("close", () => {
      if (!dlgMe.returnValue) return;
      st.me = dlgMe.returnValue;
      LS.set("alterplan.me", st.me);
      render();
    });

    // Exceptions
    const form = $("#exc-form");
    const exWho = $("#ex-who");
    const renderWho = (sel) => {
      exWho.innerHTML = ["a", "b"].map((w) => `<button type="button" role="radio" aria-checked="${w === sel}" class="${w === sel ? "on " : ""}wp-${w}" data-w="${w}">Chez ${esc(name(w))}</button>`).join("");
      exWho.dataset.w = sel;
    };
    exWho.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) renderWho(b.dataset.w); });
    $("#add-exc").onclick = () => {
      if (!canEdit()) return askEdit();
      form.hidden = !form.hidden;
      if (!form.hidden) {
        const t = today();
        $("#ex-from").value = t; $("#ex-to").value = t; $("#ex-note").value = "";
        renderWho(P.other(P.who(st.data, t)));
        $("#ex-from").focus();
      }
    };
    $("#ex-from").addEventListener("change", () => { if ($("#ex-to").value < $("#ex-from").value) $("#ex-to").value = $("#ex-from").value; });
    $("#ex-cancel").onclick = () => (form.hidden = true);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const a = $("#ex-from").value, b = $("#ex-to").value, w = exWho.dataset.w, note = $("#ex-note").value.trim();
      const days = P.range(a, b);
      if (!days.length) return toast("Dates invalides.");
      const prev = snapshot(days);
      commit((d) => P.setDays(d, days, w, note), `Exception ${P.rangeLabel(a, b)} : chez ${name(w)}${note ? ` (${note})` : ""}`, {
        undo: restore(days, prev),
        toastMsg: `${P.rangeLabel(a, b)} → chez ${name(w)}`,
      });
      form.hidden = true;
    });
    $("#exc-list").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      const li = b.closest(".ex-item"), days = P.range(li.dataset.from, li.dataset.to);
      const prev = snapshot(days);
      if (b.dataset.act === "del") {
        commit((d) => P.setDays(d, days, null, ""), `Suppression de l'exception ${P.rangeLabel(days[0], days[days.length - 1])}`, {
          undo: restore(days, prev), toastMsg: "Exception supprimée, retour au rythme",
        });
      } else {
        const main = li.querySelector(".ex-main");
        const cur = st.data.overrides[days[0]]?.n || "";
        main.insertAdjacentHTML("beforeend", `<form class="note-edit"><input type="text" maxlength="80" value="${esc(cur)}" placeholder="Note" aria-label="Note"><button class="btn small primary">OK</button></form>`);
        const f = main.querySelector(".note-edit"), inp = f.querySelector("input");
        b.disabled = true;
        inp.focus();
        f.onsubmit = (ev) => {
          ev.preventDefault();
          const n = inp.value.trim();
          commit((d) => {
            const overrides = { ...d.overrides };
            for (const x of days) if (overrides[x]) overrides[x] = n ? { ...overrides[x], n } : { w: overrides[x].w };
            return P.setDays({ ...d, overrides }, [], null);
          }, `Note ${P.rangeLabel(days[0], days[days.length - 1])} : ${n || "(supprimée)"}`, { undo: restore(days, prev) });
        };
      }
    });
    $("#exc-past").onclick = () => { st.showPast = !st.showPast; renderExc(); };

    // Événements
    const evForm = $("#ev-form");
    let evEditing = null;
    const setKind = (k) => {
      evForm.dataset.k = k;
      $$("#ev-kind button").forEach((b) => { const on = b.dataset.k === k; b.classList.toggle("active", on); b.setAttribute("aria-checked", on); });
      $("#ev-title-lbl").textContent = k === "anniv" ? "Prénom" : k === "trail" ? "Nom du trail" : "Titre";
      $("#ev-title").placeholder = k === "anniv" ? "Léo" : k === "trail" ? "Trail des Cévennes" : "Spectacle de l'école";
      $("#ev-date-lbl").textContent = k === "anniv" ? "Date de naissance" : "Date";
      $("#ev-end-wrap").hidden = k === "anniv";
      $("#ev-age-wrap").hidden = k !== "anniv";
    };
    const setEvWho = (w) => {
      $("#ev-who").innerHTML = [["", "Pour tous"], ["a", name("a")], ["b", name("b")]].map(([v, l]) => `<button type="button" role="radio" aria-checked="${v === w}" class="${v === w ? "on " : ""}wp-${v || "x"}" data-w="${v}">${esc(l)}</button>`).join("");
      $("#ev-who").dataset.w = w;
    };
    $("#ev-kind").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setKind(b.dataset.k); });
    $("#ev-who").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setEvWho(b.dataset.w); });
    const openEv = (ev) => {
      evEditing = ev ? ev.id : null;
      evForm.hidden = false;
      setKind(ev ? ev.kind : "anniv");
      $("#ev-title").value = ev ? ev.title : "";
      $("#ev-date").value = ev ? ev.date : today();
      $("#ev-end").value = ev && ev.end ? ev.end : "";
      $("#ev-age").checked = ev ? !!ev.year : true;
      setEvWho(ev && ev.who ? ev.who : "");
      $("#ev-title").focus();
    };
    $("#add-ev").onclick = () => { if (!canEdit()) return askEdit(); evForm.hidden ? openEv(null) : (evForm.hidden = true); };
    $("#ev-cancel").onclick = () => (evForm.hidden = true);
    $("#ev-more").onclick = () => { st.showAllEv = !st.showAllEv; renderEvents(); };
    evForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const k = evForm.dataset.k, title = $("#ev-title").value.trim(), date = $("#ev-date").value;
      if (!title || !P.isIso(date)) return;
      const ev = { id: evEditing || Date.now().toString(36), kind: k, title, date };
      if (k !== "anniv" && P.isIso($("#ev-end").value) && $("#ev-end").value > date) ev.end = $("#ev-end").value;
      if (k === "anniv" && $("#ev-age").checked) ev.year = Number(date.slice(0, 4));
      if ($("#ev-who").dataset.w) ev.who = $("#ev-who").dataset.w;
      const id = ev.id, prev = st.data.events.find((x) => x.id === id) || null;
      const label = k === "anniv" ? `Anniversaire de ${title}` : title;
      commit((d) => ({ ...d, events: d.events.filter((x) => x.id !== id).concat(ev) }), `${prev ? "Modification" : "Ajout"} : ${label}`, {
        undo: (d) => ({ ...d, events: d.events.filter((x) => x.id !== id).concat(prev ? [prev] : []) }),
        toastMsg: `${P.KINDS[k].icon} ${label} ${prev ? "modifié" : "ajouté"}`,
      });
      evForm.hidden = true;
    });
    $("#ev-list").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      const id = b.closest(".ev-item").dataset.id, ev = st.data.events.find((x) => x.id === id);
      if (!ev) return;
      if (b.dataset.act === "edit") return openEv(ev);
      commit((d) => ({ ...d, events: d.events.filter((x) => x.id !== id) }), `Suppression : ${ev.title}`, {
        undo: (d) => ({ ...d, events: d.events.filter((x) => x.id !== id).concat(ev) }),
        toastMsg: `${ev.title} supprimé`,
      });
    });

    // Statistiques
    $("#stats-period").addEventListener("change", (e) => {
      st.statsPeriod = e.target.value;
      if (st.statsPeriod === "custom" && !$("#st-from").value) {
        const [a, b] = [P.addDays(today(), -182), P.addDays(today(), 182)];
        $("#st-from").value = a; $("#st-to").value = b;
      }
      renderStats();
    });
    $("#st-from").addEventListener("change", renderStats);
    $("#st-to").addEventListener("change", renderStats);

    // Réglages
    $("#settings-btn").onclick = () => openSettings();
    dlgSet.addEventListener("click", (e) => {
      if (e.target === dlgSet || e.target.closest("[data-close]")) dlgSet.close();
    });
    $("#parents-edit").addEventListener("change", (e) => {
      const inp = e.target.closest("input[type=text]");
      if (!inp) return;
      const w = inp.closest(".pe").dataset.w, v = inp.value.trim();
      if (!v || v === name(w)) return;
      commit((d) => ({ ...d, parents: { ...d.parents, [w]: { ...d.parents[w], name: v } } }), `Nom : ${v}`);
    });
    $("#parents-edit").addEventListener("click", (e) => {
      const b = e.target.closest(".sw button");
      if (!b) return;
      const w = b.closest(".pe").dataset.w, c = b.dataset.c;
      commit((d) => ({ ...d, parents: { ...d.parents, [w]: { ...d.parents[w], color: c } } }), `Couleur de ${name(w)}`);
    });
    const setRhythm = (patch, msg) => {
      if (!canEdit()) return askEdit();
      commit((d) => ({ ...d, rhythm: { ...d.rhythm, ...patch } }), msg);
    };
    $("#presets").addEventListener("click", (e) => {
      const b = e.target.closest(".preset");
      if (b) setRhythm({ preset: b.dataset.p }, `Rythme : ${P.PRESETS[b.dataset.p].label}`);
    });
    $("#rh-first").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) setRhythm({ first: b.dataset.w }, "Rythme : premier parent");
    });
    $("#rh-date").addEventListener("change", (e) => { if (P.isIso(e.target.value)) setRhythm({ ref: e.target.value }, `Rythme : référence ${e.target.value}`); });

    $("#token-save").onclick = async () => {
      const v = $("#token").value.trim();
      if (!v) return $("#token").focus();
      S.setToken(v);
      await connect();
      renderSettings();
      toast(st.mode === "remote" ? "Modification activée sur cet appareil." : `Jeton non valide : ${st.reason}`);
    };
    $("#token-clear").onclick = async () => {
      S.setToken(null);
      await connect();
      renderSettings();
    };
    $("#export").onclick = () => download(`alterplan-${today()}.json`, "application/json", JSON.stringify(st.data, null, 2));
    $("#ics").onclick = ics;
    $("#import").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (!canEdit()) return askEdit();
      try {
        const imported = P.clean(JSON.parse(await f.text()));
        const prev = st.data;
        commit(() => imported, "Import d'une sauvegarde", { undo: () => prev, toastMsg: "Sauvegarde importée" });
      } catch (err) {
        toast("Fichier illisible.");
      }
      e.target.value = "";
    });
  }

  /* ===== Thème : système (par défaut), clair ou sombre ===== */
  const THEMES = {
    system: { label: "Thème : adapté au système", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor"/></svg>' },
    light: { label: "Thème : clair", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' },
    dark: { label: "Thème : sombre", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>' },
  };
  const ORDER = ["system", "light", "dark"];
  const theme = () => { const t = LS.get("alterplan.theme"); return t === "light" || t === "dark" ? t : "system"; };
  function applyTheme(t) {
    LS.set("alterplan.theme", t === "system" ? null : t);
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    // Couleur de la barre du navigateur (mobile) : suit le thème choisi.
    $("#tc-light").media = t === "system" ? "(prefers-color-scheme: light)" : t === "light" ? "all" : "not all";
    $("#tc-dark").media = t === "system" ? "(prefers-color-scheme: dark)" : t === "dark" ? "all" : "not all";
    const b = $("#theme-btn");
    b.innerHTML = THEMES[t].svg;
    b.title = `${THEMES[t].label} (toucher pour changer)`;
    b.setAttribute("aria-label", b.title);
    $$("#theme-seg button").forEach((x) => { const on = x.dataset.t === t; x.classList.toggle("active", on); x.setAttribute("aria-checked", on); });
  }

  /* ===== Démarrage ===== */
  async function connect() {
    if (S.backend === "api") {
      const u = S.status && S.status.user;
      st.mode = u ? "remote" : "readonly";
      st.reason = "";
      setSync(u ? "ok" : "readonly");
      render();
      return;
    }
    if (S.token()) {
      const r = await S.check();
      st.mode = r.ok ? "remote" : local ? "local" : "readonly";
      st.reason = r.ok ? "" : r.reason;
    } else {
      st.mode = local ? "local" : "readonly";
      st.reason = "";
    }
    setSync(st.mode === "remote" ? "ok" : st.mode);
    render();
  }

  async function init() {
    $$("#theme-seg button").forEach((x) => x.insertAdjacentHTML("afterbegin", THEMES[x.dataset.t].svg));
    applyTheme(theme());
    $("#theme-btn").onclick = () => {
      const t = ORDER[(ORDER.indexOf(theme()) + 1) % 3];
      applyTheme(t);
      toast(THEMES[t].label);
    };
    $("#theme-seg").addEventListener("click", (e) => { const b = e.target.closest("button[data-t]"); if (b) applyTheme(b.dataset.t); });
    applyColors();
    renderSuggest();
    renderStatsOptions();
    bind();
    $("#repo-link").href = `https://github.com/${S.repo}`;
    render();
    setSync("loading");
    const api = await S.detect();
    if (api) {
      $("#foot-txt").textContent = "alterplan · planning partagé, privé, enregistré sur cet hébergement.";
      if (!api.user) return showAuth();
      return startApi();
    }
    const { data, source } = await S.load();
    if (data && !(local && S.cached() && source !== "github")) st.data = P.clean(data);
    else if (local && S.cached()) st.data = P.clean(S.cached());
    await connect();
    if (source === "cache") toast("Hors connexion : dernière version connue affichée.");
    if (!st.me) setTimeout(() => $("#me-btn").click(), 400);
    // Revenir sur l'onglet recharge la dernière version (si rien n'est en attente d'envoi).
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState !== "visible" || st.pending.length || st.mode === "local") return;
      const r = await S.load();
      if (r.data && !st.pending.length) { st.data = P.clean(r.data); render(); }
    });
  }
  /* ===== Mode comptes (API PHP) ===== */
  let watching = false;
  async function startApi() {
    hideAuth();
    const u = S.status.user;
    if (S.status.data) st.data = P.clean(S.status.data);
    if (!st.me && u.parent) { st.me = u.parent; LS.set("alterplan.me", st.me); }
    await connect();
    if (!st.me) setTimeout(() => $("#me-btn").click(), 400);
    if (watching) return;
    watching = true;
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState !== "visible" || st.pending.length || st.saving) return;
      const r = await S.load();
      if (r.source === "auth") return showAuth();
      if (r.data && !st.pending.length) { st.data = P.clean(r.data); render(); }
    });
  }
  function hideAuth() {
    $("#auth").hidden = true;
    $("#main").hidden = false;
    document.body.classList.remove("locked");
  }
  const inviteToken = () => new URLSearchParams(location.search).get("invitation") || "";
  async function showAuth(view) {
    $("#main").hidden = true;
    document.body.classList.add("locked");
    setSync("");
    const box = $("#auth");
    box.hidden = false;
    const token = inviteToken();
    let info = null;
    if (!view) {
      if (S.status && S.status.needsSetup) view = "setup";
      else if (token) {
        info = await S.Api.get("inviteinfo", `&token=${encodeURIComponent(token)}`).catch(() => ({ valid: false }));
        view = info.valid ? "register" : "login";
      } else view = "login";
    }
    const parentPick = (sel) => `<div class="who-pick" data-field="parent" role="radiogroup" aria-label="Tu es">
        <button type="button" data-w="a" class="wp-a${sel === "a" ? " on" : ""}">${esc(name("a"))}</button>
        <button type="button" data-w="b" class="wp-b${sel === "b" ? " on" : ""}">${esc(name("b"))}</button></div>`;
    const forms = {
      login: `<h1>Connexion</h1><p class="muted">Le planning est privé : connecte-toi pour le voir et le modifier.</p>
        ${token ? `<p class="err">Ce lien d'invitation n'est plus valable. Demande-en un nouveau.</p>` : ""}
        <label>Identifiant<input type="text" name="login" autocomplete="username" autocapitalize="none" required></label>
        <label>Mot de passe<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary" type="submit">Se connecter</button>`,
      setup: `<h1>Bienvenue</h1><p class="muted">Première connexion : crée ton compte administrateur. Le planning actuel sera importé.</p>
        <label>Code d'installation<input name="code" type="password" autocomplete="off" required><small>Le secret SETUP_CODE mis dans GitHub.</small></label>
        <label>Ton prénom<input type="text" name="name" autocomplete="given-name" required></label>
        <span class="lbl">Tu es</span>${parentPick("a")}
        <label>Identifiant<input type="text" name="login" autocomplete="username" autocapitalize="none" required></label>
        <label>Mot de passe<input name="password" type="password" autocomplete="new-password" minlength="8" required><small>8 caractères minimum.</small></label>
        <button class="btn primary" type="submit">Créer mon compte</button>`,
      register: `<h1>Invitation</h1><p class="muted">${esc(info && info.from ? info.from : "L'autre parent")} t'invite à partager le planning de garde.</p>
        <label>Ton prénom<input type="text" name="name" autocomplete="given-name" required></label>
        <span class="lbl">Tu es</span>${parentPick(info && info.parent ? info.parent : "b")}
        <label>Identifiant<input type="text" name="login" autocomplete="username" autocapitalize="none" required></label>
        <label>Mot de passe<input name="password" type="password" autocomplete="new-password" minlength="8" required><small>8 caractères minimum.</small></label>
        <button class="btn primary" type="submit">Créer mon compte</button>`,
    };
    box.innerHTML = `<form class="card auth-card" data-view="${view}" novalidate>
        <span class="brand-mark big" aria-hidden="true"><i></i><i></i></span>
        ${forms[view]}
        <p class="auth-err err" role="alert"></p>
      </form>`;
    const form = box.querySelector("form");
    form.addEventListener("click", (e) => {
      const b = e.target.closest(".who-pick button");
      if (!b) return;
      $$(".who-pick button", form).forEach((x) => x.classList.toggle("on", x === b));
    });
    form.querySelector("input").focus();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const picked = form.querySelector(".who-pick button.on");
      if (picked) f.parent = picked.dataset.w;
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        if (view === "login") await S.Api.post("login", { login: f.login, password: f.password });
        else if (view === "setup") await S.Api.post("setup", f);
        else await S.Api.post("register", { ...f, token });
        if (token) history.replaceState(null, "", location.pathname);
        if (f.parent && view !== "login") { st.me = f.parent; LS.set("alterplan.me", st.me); }
        await S.detect();
        if (!S.status || !S.status.user) throw new Error("Connexion impossible.");
        startApi();
        if (view !== "login") toast(view === "setup" ? "Compte créé, planning importé." : "Bienvenue !");
      } catch (err) {
        form.querySelector(".auth-err").textContent = err.message;
        btn.disabled = false;
      }
    });
  }

  /* Réglages › Compte (mode comptes) */
  async function renderAccount() {
    const sec = $("#sec-account");
    const api = S.backend === "api" && S.status && S.status.user;
    sec.hidden = !api;
    $("#sec-share").hidden = !!api;
    if (!api) return;
    const u = S.status.user;
    sec.innerHTML = `<h3>Compte</h3>
      <div class="acc-me"><p>Connecté : <strong>${esc(u.name)}</strong> <span class="muted">(${esc(u.login)})</span></p>
        <button type="button" class="btn small" id="acc-logout">Se déconnecter</button></div>
      <div class="acc-users" id="acc-users"><p class="muted small">Chargement des comptes…</p></div>
      ${u.admin ? `<div class="acc-invite">
        <p class="small">Inviter l'autre parent : un lien à usage unique, valable 14 jours.</p>
        <div class="row-btns"><button type="button" class="btn small" data-inv="b">Inviter ${esc(name("b"))}</button><button type="button" class="btn small" data-inv="a">Inviter ${esc(name("a"))}</button></div>
        <div class="inv-out" id="inv-out" hidden><input readonly id="inv-link" aria-label="Lien d'invitation"><button type="button" class="btn small primary" id="inv-copy">Copier</button></div>
      </div>` : ""}
      <details class="acc-pass"><summary>Changer de mot de passe</summary>
        <form id="acc-pass" class="token-row">
          <input type="password" name="old" placeholder="Actuel" autocomplete="current-password" required>
          <input type="password" name="new" placeholder="Nouveau (8 car. min.)" autocomplete="new-password" minlength="8" required>
          <button class="btn small primary">Changer</button>
        </form></details>
      <details class="acc-hist" id="acc-hist"><summary>Dernières modifications</summary><ul id="hist-list"></ul></details>`;
    $("#acc-logout").onclick = async () => {
      await S.Api.post("logout").catch(() => {});
      S.status = { ...S.status, user: null };
      LS.set("alterplan.cache", null);
      dlgSet.close();
      showAuth("login");
    };
    $$("[data-inv]", sec).forEach((b) => (b.onclick = async () => {
      try {
        const j = await S.Api.post("invite", { parent: b.dataset.inv });
        const url = `${location.origin}${location.pathname}?invitation=${j.token}`;
        $("#inv-out").hidden = false;
        $("#inv-link").value = url;
        $("#inv-link").select();
      } catch (e) { toast(e.message); }
    }));
    const copy = $("#inv-copy");
    if (copy) copy.onclick = async () => {
      const url = $("#inv-link").value;
      if (navigator.share) { try { await navigator.share({ title: "alterplan", text: "Invitation au planning de garde", url }); return; } catch (e) { /* annulé */ } }
      try { await navigator.clipboard.writeText(url); toast("Lien copié."); } catch (e) { $("#inv-link").select(); }
    };
    $("#acc-pass").onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try { await S.Api.post("password", f); e.target.reset(); toast("Mot de passe changé. Les autres appareils sont déconnectés."); }
      catch (err) { toast(err.message); }
    };
    $("#acc-hist").addEventListener("toggle", async (e) => {
      if (!e.target.open) return;
      const j = await S.Api.get("history").catch(() => ({ history: [] }));
      $("#hist-list").innerHTML = j.history.map((h) => {
        const d = new Date(h.at.replace(" ", "T") + "Z");
        return `<li><span class="muted">${d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span> <strong>${esc(h.name || "?")}</strong> · ${esc(h.message)}</li>`;
      }).join("") || `<li class="muted">Rien pour l'instant.</li>`;
    }, { once: false });
    try {
      const j = await S.Api.get("users");
      $("#acc-users").innerHTML = `<p class="small muted">Comptes</p><ul>${j.users.map((x) => `<li>${x.parent ? pill(x.parent, x.name) : `<span class="who"><i></i>${esc(x.name)}</span>`} <span class="muted small">${esc(x.login)}${x.admin ? " · admin" : ""}</span>
        ${u.admin && x.id !== u.id ? `<button type="button" class="link-btn small" data-del="${x.id}">Supprimer</button>` : ""}</li>`).join("")}</ul>`;
      $$("[data-del]", sec).forEach((b) => (b.onclick = async () => {
        if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Confirmer la suppression"; return; }
        try { await S.Api.post("deluser", { id: Number(b.dataset.del) }); renderAccount(); } catch (e) { toast(e.message); }
      }));
    } catch (e) {
      $("#acc-users").innerHTML = "";
    }
  }

  init();
})();
