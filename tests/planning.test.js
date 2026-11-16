const test = require("node:test");
const assert = require("node:assert/strict");
require("../planning.js");
const P = globalThis.Planning;

const data = P.clean({ rhythm: { preset: "alt1", first: "a", ref: "2026-11-16" } });
const T = "2026-11-16"; // lundi

test("alternance hebdomadaire, bascule le lundi", () => {
  for (const d of ["2026-11-16", "2026-11-22"]) assert.equal(P.who(data, d), "a", d);
  for (const d of ["2026-11-23", "2026-11-29"]) assert.equal(P.who(data, d), "b", d);
  assert.equal(P.who(data, "2026-11-30"), "a");
  assert.equal(P.who(data, "2026-11-15"), "b"); // avant la référence aussi
  assert.equal(P.who(data, "2027-10-18"), "a"); // changement d'heure sans effet (48 semaines plus tard)
});

test("bascule le vendredi si la référence est un vendredi", () => {
  const d2 = P.clean({ rhythm: { preset: "alt1", first: "b", ref: "2026-11-20" } });
  assert.equal(P.who(d2, "2026-11-19"), "a");
  assert.equal(P.who(d2, "2026-11-20"), "b");
  assert.equal(P.who(d2, "2026-11-26"), "b");
  assert.equal(P.who(d2, "2026-11-27"), "a");
});

test("un week-end sur deux", () => {
  const d3 = P.clean({ rhythm: { preset: "we2", first: "a", ref: "2026-11-18" } });
  assert.equal(P.who(d3, "2026-11-20"), "b");
  assert.equal(P.who(d3, "2026-11-21"), "a");
  assert.equal(P.who(d3, "2026-11-22"), "a");
  assert.equal(P.who(d3, "2026-11-28"), "b");
  assert.equal(P.who(d3, "2026-12-05"), "a");
});

test("exceptions : inverser une semaine, un week-end, un jour, et revenir", () => {
  let d = P.toggleDays(data, P.weekDays("2026-11-18"));
  assert.equal(P.who(d, "2026-11-16"), "b");
  assert.equal(Object.keys(d.overrides).length, 7);
  d = P.toggleDays(d, P.weekDays("2026-11-18"));
  assert.equal(Object.keys(d.overrides).length, 0, "retour au rythme = aucune exception");
  d = P.toggleDays(data, P.weekendDays("2026-11-25"));
  assert.equal(P.who(d, "2026-11-28"), "a");
  assert.equal(P.who(d, "2026-11-27"), "b");
  d = P.setDays(d, P.range("2026-12-24", "2026-12-26"), "b", "Noël");
  assert.deepEqual(P.periods(d).map((p) => [p.from, p.to, p.w, p.n]), [
    ["2026-11-28", "2026-11-29", "a", ""],
    ["2026-12-24", "2026-12-26", "b", "Noël"],
  ]);
  const day = P.day(d, "2026-12-24");
  assert.ok(day.exc && day.note === "Noël");
});

test("statistiques", () => {
  const s = P.stats(data, "2026-11-16", "2026-12-13");
  assert.equal(s.total, 28);
  assert.equal(s.a, 14); assert.equal(s.b, 14);
  assert.equal(s.weA, 2); assert.equal(s.weB, 2);
  assert.equal(s.months.length, 2);
});

test("prochain changement et début de période", () => {
  assert.equal(P.nextSwitch(data, "2026-11-18"), "2026-11-23");
  assert.equal(P.periodStart(data, "2026-11-18"), "2026-11-16");
});

test("recherche en français", () => {
  const p = (s) => { const r = P.parse(s, T); return r && [r.from, r.to]; };
  assert.deepEqual(p("le 17 juin, suis-je dispo ?"), ["2027-06-17", "2027-06-17"]);
  assert.deepEqual(p("17/06"), ["2027-06-17", "2027-06-17"]);
  assert.deepEqual(p("17 juin 2028"), ["2028-06-17", "2028-06-17"]);
  assert.deepEqual(p("1er décembre"), ["2026-12-01", "2026-12-01"]);
  assert.deepEqual(p("16 novembre"), ["2026-11-16", "2026-11-16"]);
  assert.deepEqual(p("demain"), ["2026-11-17", "2026-11-17"]);
  assert.deepEqual(p("samedi"), ["2026-11-21", "2026-11-21"]);
  assert.deepEqual(p("lundi prochain"), ["2026-11-23", "2026-11-23"]);
  assert.deepEqual(p("ce week-end"), ["2026-11-21", "2026-11-22"]);
  assert.deepEqual(p("week-end prochain"), ["2026-11-21", "2026-11-22"]); // dit un lundi : le prochain à venir
  assert.equal(P.parse("week-end prochain", "2026-11-21").from, "2026-11-28"); // dit un samedi : le suivant
  assert.deepEqual(p("la semaine prochaine"), ["2026-11-23", "2026-11-29"]);
  assert.deepEqual(p("du 10 au 15 août"), ["2027-08-10", "2027-08-15"]);
  assert.deepEqual(p("du 28 décembre au 3 janvier"), ["2026-12-28", "2027-01-03"]);
  assert.deepEqual(p("du 3/07 au 12/07"), ["2027-07-03", "2027-07-12"]);
  assert.deepEqual(p("en août"), ["2027-08-01", "2027-08-31"]);
  assert.deepEqual(p("noël"), ["2026-12-25", "2026-12-25"]);
  assert.deepEqual(p("dans 3 semaines"), ["2026-12-07", "2026-12-07"]);
  assert.deepEqual(p("dans 2 mois"), ["2027-01-16", "2027-01-16"]);
  assert.deepEqual(p("week-end du 12 décembre"), ["2026-12-12", "2026-12-13"]);
  assert.deepEqual(p("semaine du 2 décembre"), ["2026-11-30", "2026-12-06"]);
  assert.equal(P.parse("n'importe quoi", T), null);
  assert.equal(P.parse("31 février", T), null);
});

require("../feries.js");
const F = globalThis.Feries;

test("jours fériés et vacances zone C", () => {
  assert.equal(F.easter(2027), "2027-03-28");
  assert.equal(F.ferie("2027-05-06"), "Ascension");
  assert.equal(F.ferie("2027-05-17"), "Lundi de Pentecôte");
  assert.equal(F.ferie("2026-12-25"), "Noël");
  assert.equal(F.ferie("2026-12-24"), null);
  assert.equal(F.vacances("2026-12-25").key, "noel");
  assert.equal(F.vacances("2027-01-04"), null);
  assert.equal(F.findVacances("vacances de noël", T).from, "2026-12-19");
  assert.equal(F.findVacances("toussaint 2027", T).from, "2027-10-23");
  assert.equal(F.findVacances("vacances", T).key, "noel");
  assert.equal(F.findVacances("fête nationale", T), null);
});

test("événements : anniversaire annuel, trail sur plusieurs jours, recherche", () => {
  const d = P.clean({ ...data, events: [
    { id: "1", kind: "anniv", title: "Léo", date: "2018-06-17", year: 2018 },
    { id: "2", kind: "trail", title: "Trail des Cévennes", date: "2027-05-15", end: "2027-05-16" },
    { id: "3", kind: "anniv", title: "Mamie", date: "2000-02-29" },
  ] });
  assert.equal(P.eventsOn(d, "2027-06-17")[0].age, 9);
  assert.equal(P.eventsOn(d, "2027-05-16")[0].title, "Trail des Cévennes");
  assert.equal(P.eventsOn(d, "2027-02-28")[0].title, "Mamie");
  assert.deepEqual(P.upcoming(d, T, 3).map((e) => e.on), ["2027-02-28", "2027-05-15", "2027-06-17"]);
  assert.equal(P.findEvent(d, "anniversaire de léo", T).on, "2027-06-17");
  assert.equal(P.findEvent(d, "cévennes", T).on, "2027-05-15");
});
