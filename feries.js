/* alterplan · jours fériés et vacances scolaires (zone C : académies de Montpellier et Toulouse,
 * donc toutes les communes nommées Aigues-Vives).
 * Source des vacances : calendrier officiel du ministère (education.gouv.fr, service-public.gouv.fr).
 * Une période va du premier jour sans classe (le samedi, après les cours du vendredi) au dernier
 * jour avant la reprise. À compléter chaque année quand le ministère publie l'année suivante. */
(function (root) {
  const VACANCES = [
    ["toussaint", "Vacances de la Toussaint", "2025-10-18", "2025-11-02"],
    ["noel", "Vacances de Noël", "2025-12-20", "2026-01-04"],
    ["hiver", "Vacances d'hiver", "2026-02-21", "2026-03-08"],
    ["printemps", "Vacances de printemps", "2026-04-18", "2026-05-03"],
    ["ascension", "Pont de l'Ascension", "2026-05-14", "2026-05-17"],
    ["ete", "Vacances d'été", "2026-07-04", "2026-08-31"],
    ["toussaint", "Vacances de la Toussaint", "2026-10-17", "2026-11-01"],
    ["noel", "Vacances de Noël", "2026-12-19", "2027-01-03"],
    ["hiver", "Vacances d'hiver", "2027-02-06", "2027-02-21"],
    ["printemps", "Vacances de printemps", "2027-04-03", "2027-04-18"],
    ["ascension", "Pont de l'Ascension", "2027-05-06", "2027-05-09"],
    ["ete", "Vacances d'été", "2027-07-03", "2027-09-01"],
    ["toussaint", "Vacances de la Toussaint", "2027-10-23", "2027-11-07"],
    ["noel", "Vacances de Noël", "2027-12-18", "2028-01-02"],
    ["hiver", "Vacances d'hiver", "2028-02-12", "2028-02-27"],
    ["printemps", "Vacances de printemps", "2028-04-15", "2028-05-01"],
    ["ascension", "Pont de l'Ascension", "2028-05-25", "2028-05-28"],
    ["ete", "Vacances d'été", "2028-07-05", "2028-08-31"],
  ].map(([key, name, from, to]) => ({ key, name, from, to }));
  const LAST = VACANCES[VACANCES.length - 1].to;

  const iso = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
  const shift = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

  /* Dimanche de Pâques (algorithme de Meeus / Butcher). */
  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return iso(y, month, day);
  }
  const cache = {};
  function feriesOf(y) {
    if (cache[y]) return cache[y];
    const p = easter(y);
    return (cache[y] = {
      [iso(y, 1, 1)]: "Jour de l'an",
      [shift(p, 1)]: "Lundi de Pâques",
      [iso(y, 5, 1)]: "Fête du Travail",
      [iso(y, 5, 8)]: "Victoire 1945",
      [shift(p, 39)]: "Ascension",
      [shift(p, 50)]: "Lundi de Pentecôte",
      [iso(y, 7, 14)]: "Fête nationale",
      [iso(y, 8, 15)]: "Assomption",
      [iso(y, 11, 1)]: "Toussaint",
      [iso(y, 11, 11)]: "Armistice 1918",
      [iso(y, 12, 25)]: "Noël",
    });
  }

  const F = {
    VACANCES, LAST, easter,
    ferie: (d) => feriesOf(Number(d.slice(0, 4)))[d] || null,
    vacances: (d) => VACANCES.find((v) => v.from <= d && d <= v.to) || null,
    /* Prochaines vacances (en cours comprises) à partir de d. */
    nextVacances: (d, n = 1) => VACANCES.filter((v) => v.to >= d).slice(0, n),
    /* Recherche par nom : « vacances de noël », « toussaint », « été »… -> prochaine période. */
    findVacances(q, today) {
      const s = String(q || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      if (!/vacances|toussaint|\bhiver\b|printemps|paques|\bete\b|grandes vacances|ascension/.test(s)) return null;
      const key = /toussaint/.test(s) ? "toussaint" : /noel/.test(s) ? "noel" : /\bhiver\b|fevrier|\bski\b/.test(s) ? "hiver"
        : /printemps|paques|avril/.test(s) ? "printemps" : /ascension|\bpont\b/.test(s) ? "ascension" : /\bete\b|grandes|juillet|aout/.test(s) ? "ete" : null;
      const yr = (s.match(/\b(20\d\d)\b/) || [])[1];
      const list = VACANCES.filter((v) => (!key || v.key === key) && (yr ? v.from.startsWith(yr) || v.to.startsWith(yr) : v.to >= today));
      if (!key && !/^(les )?(prochaines )?vacances( scolaires)?$/.test(s.trim())) return null;
      return list[0] || null;
    },
  };
  root.Feries = F;
})(typeof window !== "undefined" ? window : globalThis);
