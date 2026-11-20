# alterplan

Planning de garde partagé entre les deux parents : chez qui sont les enfants, jour après jour.
Site statique, en ligne sur https://alterplan.quiquandou.fr (hébergement quiquandou.fr, déployé par FTP
à chaque push sur `main` : `.github/workflows/deploy-ftp.yml`). Copie de secours sur GitHub Pages.

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

## Comptes, plannings et base de données (alterplan.quiquandou.fr)

Sur l'hébergement OVH, les plannings sont dans une base MySQL, derrière une petite API PHP (`api/index.php`).
Le site est public : chacun peut créer un compte et ses propres plannings, qui restent privés (connexion obligatoire).

- **Inscription libre** avec confirmation de l'adresse par e-mail (lien valable 3 jours), « mot de passe oublié »
  (lien valable 2 heures). Connexion par e-mail ou identifiant. Options de `api/config.php` :
  `'signup' => false` pour n'accepter que les personnes invitées, `'verify_email' => false` pour ne pas confirmer les adresses.
- **Plusieurs plannings par compte** (menu en haut à gauche). Celui qui crée un planning en est l'admin ;
  il invite par lien (à usage unique, 14 jours) un parent, l'autre parent ou un proche, comme membre ou comme admin.
  Chaque membre choisit son rôle dans le planning (l'un des deux parents, ou ni l'un ni l'autre).
- **Réglages › Planning** : renommer, membres (rôle, e-mail, arrivée, dernière visite, modifications), invitations
  en attente, nommer ou retirer un admin, retirer un membre, historique, quitter, supprimer (en recopiant son nom).
- **Réglages › Mon compte** : prénom, notifications par e-mail, mot de passe, export de toutes ses données (JSON),
  suppression du compte (les plannings dont on est seul membre sont supprimés, ailleurs un autre membre devient admin si besoin).
- Pages légales : `mentions-legales.html`, `confidentialite.html` (RGPD), `cgu.html`.
- Premier passage sur une base vide : écran « Bienvenue » avec le code `SETUP_CODE` (compte administrateur
  du site), le planning de `data.json` est importé. Une base créée avant les plannings multiples est migrée
  automatiquement (le planning existant devient « Planning de garde », chaque compte en devient membre, l'admin en reste admin).
- Enregistrement avec numéro de version : si deux personnes modifient en même temps, les changements sont fusionnés.
- `api/config.php` est généré au déploiement à partir des secrets de l'environnement GitHub
  `FTP_ALTERPLAN_OVH` (`DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `SETUP_CODE`) ; il n'est jamais versionné.
- Tests de l'API : `tests/api.test.sh` contre `php -S` avec une base SQLite (lancés aussi au déploiement).

## Partage des données (copie GitHub Pages)

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
