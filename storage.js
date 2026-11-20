/* alterplan · stockage partagé. Deux modes :
 *   - « api » (alterplan.quiquandou.fr) : API PHP + MySQL sur l'hébergement OVH, comptes des parents ;
 *   - « github » (copie GitHub Pages, ou tant que la base n'est pas configurée) : data.json du repo.
 * Mode github :
 *   - lecture : API GitHub (toujours à jour), sinon data.json servi par GitHub Pages ;
 *   - écriture : API GitHub avec un jeton personnel, gardé dans ce navigateur uniquement.
 * Une copie locale permet d'afficher le planning tout de suite et hors connexion. */
(function (root) {
  const LS = {
    get(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? root.localStorage.removeItem(k) : root.localStorage.setItem(k, v); } catch (e) { /* navigation privée */ } },
  };
  const K = { token: "alterplan.token", repo: "alterplan.repo", cache: "alterplan.cache" };
  const PATH = "data.json";
  const BRANCH = "main";

  /* gcsys.github.io/alterplan -> gcsys/alterplan ; sinon le réglage, sinon gcsys/alterplan
   * (cas du domaine alterplan.quiquandou.fr). */
  function guessRepo() {
    const saved = LS.get(K.repo);
    if (saved && /^[\w.-]+\/[\w.-]+$/.test(saved)) return saved;
    const h = (root.location && root.location.hostname) || "";
    const m = h.match(/^([\w-]+)\.github\.io$/i);
    if (m) {
      const seg = (root.location.pathname.split("/").filter(Boolean)[0]) || `${m[1]}.github.io`;
      return `${m[1]}/${seg}`;
    }
    return "gcsys/alterplan";
  }

  const b64encode = (s) => {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const b64decode = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

  /* ===== API PHP (même domaine) ===== */
  async function call(a, body, query = "") {
    const r = await fetch(`api/index.php?a=${a}${query}`, body === undefined
      ? { credentials: "same-origin", cache: "no-store" }
      : { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", "X-Alterplan": "1" }, body: JSON.stringify(body) });
    let j = null;
    try { j = await r.json(); } catch (e) { /* pas du JSON : pas d'API ici */ }
    if (!j) { const e = new Error("API indisponible"); e.status = r.status; e.code = "noapi"; throw e; }
    j.status = r.status;
    return j;
  }
  const fail = (j) => { const e = new Error(j.error || `Erreur ${j.status}`); e.status = j.status; e.code = j.code; throw e; };
  const Api = {
    call,
    async post(a, body = {}) { const j = await call(a, body); if (j.error) fail(j); return j; },
    async get(a, query = "") { const j = await call(a, undefined, query); if (j.error) fail(j); return j; },
  };

  const S = {
    backend: "github", // devient "api" si l'API PHP répond
    status: null,
    version: 0,
    Api,
    /* Choisit le mode. -> statut de l'API ou null (mode github). */
    async detect() {
      const h = (root.location && root.location.hostname) || "";
      if (root.location.protocol === "file:" || /\.github\.io$/i.test(h)) return null;
      try {
        const j = await call("status");
        if (j.error || !("needsSetup" in j)) return null; // API absente ou base pas encore configurée
        S.backend = "api";
        S.status = j;
        if (j.user) S.version = j.version || 0;
        return j;
      } catch (e) {
        return null;
      }
    },

    repo: guessRepo(),
    sha: null,
    token: () => LS.get(K.token) || "",
    setToken(t) { LS.set(K.token, t ? t.trim() : null); },
    setRepo(r) { LS.set(K.repo, r || null); S.repo = guessRepo(); S.sha = null; },
    cached() {
      try { return JSON.parse(LS.get(K.cache)); } catch (e) { return null; }
    },
    cache(data) { LS.set(K.cache, JSON.stringify(data)); },

    headers(auth = true) {
      const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
      if (auth && S.token()) h.Authorization = `Bearer ${S.token()}`;
      return h;
    },
    api: (p) => `https://api.github.com/repos/${S.repo}${p}`,

    /* -> {data, source: "github" | "pages" | "cache" | "defaut"} */
    async load() {
      if (S.backend === "api") {
        try {
          const j = await call("status");
          S.status = j;
          if (!j.user) return { data: null, source: "auth" };
          S.version = j.version || 0;
          if (j.data) S.cache(j.data);
          return { data: j.data, source: "api" };
        } catch (e) {
          const c = S.cached();
          return c ? { data: c, source: "cache" } : { data: null, source: "defaut" };
        }
      }
      try {
        const r = await fetch(S.api(`/contents/${PATH}?ref=${BRANCH}&t=${Date.now()}`), { headers: S.headers(), cache: "no-store" });
        if (r.ok) {
          const j = await r.json();
          S.sha = j.sha;
          const data = JSON.parse(b64decode(j.content));
          S.cache(data);
          return { data, source: "github" };
        }
        if (r.status === 404) {
          S.sha = null;
          return { data: null, source: "absent" };
        }
      } catch (e) { /* hors connexion ou limite atteinte : on tente la suite */ }
      try {
        const r = await fetch(`${PATH}?t=${Date.now()}`, { cache: "no-store" });
        if (r.ok) {
          const data = await r.json();
          return { data, source: "pages" };
        }
      } catch (e) { /* hors connexion */ }
      const c = S.cached();
      return c ? { data: c, source: "cache" } : { data: null, source: "defaut" };
    },

    /* Le jeton peut-il écrire dans le repo ? -> {ok, reason} */
    async check() {
      if (S.backend === "api") return S.status && S.status.user ? { ok: true } : { ok: false, reason: "Non connecté." };
      if (!S.token()) return { ok: false, reason: "Aucun jeton." };
      try {
        const r = await fetch(S.api(""), { headers: S.headers(), cache: "no-store" });
        if (r.status === 401) return { ok: false, reason: "Jeton refusé par GitHub (expiré ou mal copié)." };
        if (r.status === 404) return { ok: false, reason: `Le jeton ne voit pas le repo ${S.repo}.` };
        if (!r.ok) return { ok: false, reason: `GitHub répond ${r.status}.` };
        const j = await r.json();
        if (j.permissions && j.permissions.push === false) return { ok: false, reason: "Ce jeton peut lire mais pas écrire." };
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: "Pas de connexion à GitHub." };
      }
    },

    /* Enregistre data.json (un commit). Si l'autre parent a enregistré entre-temps, `rebase`
     * reçoit sa version et rend la version à écrire (ses changements + les nôtres). */
    async save(data, message = "Mise à jour du planning", rebase = null) {
      if (S.backend === "api") {
        for (let attempt = 0; attempt < 4; attempt++) {
          S.cache(data);
          const j = await call("save", { data, version: S.version, message });
          if (j.ok) { S.version = j.version; return data; }
          if (j.code === "conflict") {
            S.version = j.version;
            if (rebase) data = rebase(j.data || {});
            continue;
          }
          fail(j);
        }
        throw new Error("Conflit d'enregistrement, réessaie.");
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        S.cache(data);
        const r = await fetch(S.api(`/contents/${PATH}`), {
          method: "PUT",
          headers: { ...S.headers(), "Content-Type": "application/json" },
          body: JSON.stringify({
            message, branch: BRANCH,
            content: b64encode(JSON.stringify(data, null, 2) + "\n"),
            ...(S.sha ? { sha: S.sha } : {}),
          }),
        });
        if (r.ok) {
          S.sha = (await r.json()).content.sha;
          return data;
        }
        if (r.status === 409 || r.status === 422) {
          const remote = await fetch(S.api(`/contents/${PATH}?ref=${BRANCH}&t=${Date.now()}`), { headers: S.headers(), cache: "no-store" });
          if (remote.ok) {
            const j = await remote.json();
            S.sha = j.sha;
            if (rebase) data = rebase(JSON.parse(b64decode(j.content)));
          } else S.sha = null;
          continue;
        }
        const j = await r.json().catch(() => ({}));
        throw new Error(r.status === 401 ? "Jeton refusé par GitHub." : r.status === 403 || r.status === 404 ? "Ce jeton ne peut pas écrire dans le repo." : j.message || `Erreur GitHub ${r.status}`);
      }
      throw new Error("Conflit d'enregistrement, réessaie.");
    },
  };

  root.Store = S;
})(typeof window !== "undefined" ? window : globalThis);
