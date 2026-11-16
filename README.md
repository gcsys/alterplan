# alterplan

Planning de garde partagé entre les deux parents : chez qui sont les enfants, jour après jour.
Site statique hébergé sur GitHub Pages, sans serveur ni compte à créer.

## Ce que fait le site

- **Aujourd'hui** : chez qui sont les enfants, jusqu'à quand, et les 8 prochaines semaines en un coup d'œil.
  Avec « Je suis… » choisi, le site répond aussi « tu es dispo » / « tu as les enfants » et donne le
  prochain week-end libre.
- **Recherche rapide** en français : « le 17 juin, suis-je dispo ? », « samedi », « ce week-end »,
  « semaine prochaine », « du 10 au 15 août », « en juillet », « Noël », « dans 3 semaines »…
- **Calendrier** façon « Mes semaines » de Trail Agrégateur : une ligne par semaine, à toucher.
  Le sélecteur *Semaine / Week-end / Jour* dit ce qu'un toucher inverse. Chaque changement peut être annulé.
- **Rythme de base** (réglages) : une semaine sur deux, deux semaines sur deux, 2-2-3, un week-end
  sur deux, ou aucun. Le jour de la date de référence est le jour d'échange (un vendredi = échange le vendredi).
- **Exceptions** : périodes ajoutées à la main (vacances, fêtes…) avec une note, modifiables et supprimables.
  Elles l'emportent toujours sur le rythme.
- **Statistiques** : jours et pourcentage chez chaque parent, week-ends, jours en exception, écart et
  détail mois par mois, sur l'année, l'année scolaire, 12 mois glissants ou une période libre.
- **Événements** : anniversaires (rappel chaque année, avec l'âge), trails (sur un ou plusieurs jours),
  autres événements. Visibles dans le calendrier, l'accueil, la recherche (« anniversaire de Léo ») et l'export .ics.
- **Vacances scolaires (zone C, Aigues-Vives) et jours fériés** dans le calendrier, la recherche
  (« vacances de Noël », « Toussaint 2027 ») et les statistiques (répartition des jours de vacances).
  Les dates des vacances sont dans `feries.js` (jusqu'à l'été 2028) : à compléter quand le ministère
  publie l'année suivante. Les jours fériés sont calculés automatiquement.
- **Export** JSON, import, et fichier `.ics` à ajouter à un agenda (Google, Apple, Outlook).

## Partage des données

Le planning est le fichier [`data.json`](data.json) de ce repo. Tout le monde lit la même version.
Pour modifier depuis un appareil, ouvrir **Réglages › Partage et modification** et coller un jeton GitHub
*fine-grained* limité à ce repo, permission **Contents : Read and write**. Le jeton reste dans le navigateur.
Chaque modification devient un commit (historique complet dans GitHub). Si les deux parents modifient en
même temps, les deux changements sont fusionnés.

Le repo est public (nécessaire pour GitHub Pages gratuit) : `data.json` ne contient que les deux prénoms
et des dates.

## Développement

```
python3 -m http.server   # puis http://localhost:8000 (mode local : les changements restent dans le navigateur)
npm test                 # node --test tests/*.test.js
```

- `planning.js` : logique pure (rythme, exceptions, stats, recherche), testée sous Node.
- `feries.js` : jours fériés (calculés) et vacances scolaires zone C.
- `storage.js` : lecture / écriture de `data.json` via l'API GitHub.
- `app.js`, `index.html`, `style.css` : interface.
