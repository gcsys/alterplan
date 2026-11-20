#!/usr/bin/env bash
# Test de bout en bout de l'API PHP (base SQLite jetable).
# Usage : ALTERPLAN_CONFIG=… MAIL_LOG=… tests/api.test.sh http://127.0.0.1:8770
# (serveur lancé avec la même ALTERPLAN_CONFIG, config SQLite avec 'mail_log' => $MAIL_LOG)
set -u
B="${1:-http://127.0.0.1:8770}/api/index.php"
: "${MAIL_LOG:?MAIL_LOG requis, fichier des e-mails écrits par l API}"
J1=$(mktemp) J2=$(mktemp) J3=$(mktemp)
fails=0
check() { if echo "$2" | grep -q -- "$3"; then echo "ok   - $1"; else echo "FAIL - $1 : $2"; fails=$((fails+1)); fi; }
post() { curl -s -b "$1" -c "$1" -H 'X-Alterplan: 1' -H 'Content-Type: application/json' -X POST "$B?a=$2" -d "$3"; }
get() { curl -s -b "$1" -c "$1" "$B?a=$2"; }
lastlink() { grep -o "$1=[a-f0-9]*" "$MAIL_LOG" | tail -1 | cut -d= -f2; }
: > "$MAIL_LOG"

# --- Installation et planning historique
check "installation demandée" "$(get "$J1" status)" '"needsSetup":true'
check "sans en-tête : refusé" "$(curl -s -X POST "$B?a=setup" -d '{}')" 'Requête refusée'
check "mauvais code" "$(post "$J1" setup '{"code":"x","login":"gael","password":"motdepasse1"}')" 'incorrect'
check "mot de passe court" "$(post "$J1" setup '{"code":"secret-code","login":"gael","password":"court"}')" 'trop court'
check "premier compte" "$(post "$J1" setup '{"code":"secret-code","login":"Gael","name":"Gaël","password":"motdepasse1"}')" '"ok":true'
S=$(get "$J1" status)
check "connecté + planning importé" "$S" '"login":"gael"'
check "planning version 1" "$S" '"version":1'
check "admin du planning" "$S" '"planning":{"id":1,"name":"Planning de garde","role":"admin"'
check "second setup refusé" "$(post "$J2" setup '{"code":"secret-code","login":"x","password":"motdepasse1"}')" 'existe déjà'
check "anonyme : pas de planning" "$(get "$J2" status)" '"user":null'
check "anonyme : save refusé" "$(post "$J2" save '{"data":{},"version":1}')" 'Connexion nécessaire'
check "enregistrement" "$(post "$J1" "save&p=1" '{"data":{"overrides":{"2026-12-24":{"w":"b"}}},"version":1,"message":"Noël"}')" '"version":2'
C=$(post "$J1" "save&p=1" '{"data":{"overrides":{}},"version":1}')
check "conflit de version" "$C" '"code":"conflict"'
check "conflit renvoie la version courante" "$C" '2026-12-24'

# --- Invitation + inscription avec e-mail confirmé
INV=$(post "$J1" invite '{"parent":"b"}')
TOKEN=$(echo "$INV" | sed -E 's/.*"token":"([a-f0-9]+)".*/\1/')
check "invitation" "$INV" '"token"'
check "infos invitation" "$(get "$J2" "inviteinfo&token=$TOKEN")" '"planning":"Planning de garde"'
check "inscription sans CGU refusée" "$(post "$J2" signup "{\"token\":\"$TOKEN\",\"email\":\"maman@example.org\",\"name\":\"Maman\",\"password\":\"motdepasse2\"}")" 'conditions'
check "inscription" "$(post "$J2" signup "{\"token\":\"$TOKEN\",\"email\":\"Maman@Example.org\",\"name\":\"Maman\",\"password\":\"motdepasse2\",\"terms\":true}")" '"verify":true'
check "invitation à usage unique" "$(post "$J3" signup "{\"token\":\"$TOKEN\",\"email\":\"autre@example.org\",\"name\":\"A\",\"password\":\"motdepasse2\",\"terms\":true}")" 'invalide'
check "pas encore confirmé" "$(post "$J2" login '{"login":"maman@example.org","password":"motdepasse2"}')" '"code":"unverified"'
check "e-mail de confirmation" "$(cat "$MAIL_LOG")" 'confirmer='
check "mauvais lien refusé" "$(post "$J2" confirm '{"token":"abc"}')" 'invalide'
check "confirmation" "$(post "$J2" confirm "{\"token\":\"$(lastlink confirmer)\"}")" '"ok":true'
check "Maman voit le planning" "$(get "$J2" status)" '"parent":"b","admin":false'
check "Maman ne peut pas inviter" "$(post "$J2" invite '{}')" 'administrateurs'
check "adresse déjà prise" "$(post "$J3" signup '{"email":"maman@example.org","name":"X","password":"motdepasse3","terms":true}')" 'existe déjà'

# --- Membres
check "liste des membres" "$(get "$J1" users)" '"login":"maman@example.org"'
check "admin : dernière visite" "$(get "$J1" users)" '"lastSeen"'
check "membre : pas les détails" "$(get "$J2" users | grep -c lastSeen)" '^0$'
post "$J1" invite '{"parent":"a"}' > /dev/null
check "invitation en attente listée" "$(get "$J1" users)" '"invites":\[{"id"'
RID=$(get "$J1" users | sed -E 's/.*"invites":\[\{"id":"([a-f0-9]+)".*/\1/')
check "annulation d'invitation" "$(post "$J1" revoke "{\"id\":\"$RID\"}")" '"ok":true'
check "invitation annulée" "$(get "$J1" users)" '"invites":\[\]'
MID=$(get "$J2" status | sed -E 's/.*"user":\{"id":([0-9]+).*/\1/')
check "dernier admin protégé" "$(post "$J1" member '{"id":1,"role":"member"}')" 'au moins un administrateur'
check "Maman devient admin" "$(post "$J1" member "{\"id\":$MID,\"role\":\"admin\"}")" '"ok":true'
check "Maman peut inviter" "$(post "$J2" invite '{}')" '"token"'
check "historique" "$(get "$J1" history)" 'Noël'

# --- Plusieurs plannings
P2=$(post "$J2" create '{"name":"Garde de Léo","parent":"b","data":{"parents":{"a":{"name":"Marc"},"b":{"name":"Maman"}}}}')
check "nouveau planning" "$P2" '"id":2'
check "deux plannings" "$(get "$J2" "status&p=2")" '"plannings":\[{"id":1.*{"id":2,"name":"Garde de Léo","role":"admin"'
check "planning 2 sélectionné" "$(get "$J2" "status&p=2")" '"name":"Marc"'
check "Gaël n'y a pas accès" "$(post "$J1" "save&p=2" '{"data":{},"version":1}')" 'introuvable'
check "renommer" "$(post "$J2" "settings&p=2" '{"name":"Léo"}')" '"name":"Léo"'
check "historique séparé" "$(get "$J2" "history&p=2" | grep -c Noël)" '^0$'
check "suppression : nom exigé" "$(post "$J2" "delplanning&p=2" '{"confirm":"x"}')" 'Recopie'
check "suppression du planning" "$(post "$J2" "delplanning&p=2" '{"confirm":"Léo"}')" '"ok":true'
check "planning supprimé" "$(get "$J2" "status&p=2")" '"planning":{"id":1'

# --- Session, mot de passe, mot de passe oublié
check "déconnexion" "$(post "$J2" logout '{}')" '"ok":true'
check "déconnecté" "$(get "$J2" status)" '"user":null'
check "mauvais mot de passe" "$(post "$J2" login '{"login":"maman@example.org","password":"faux12345"}')" 'incorrect'
check "connexion par e-mail" "$(post "$J2" login '{"login":"MAMAN@example.org","password":"motdepasse2"}')" '"ok":true'
check "changement de mot de passe" "$(post "$J2" password '{"old":"motdepasse2","new":"nouveau-mdp"}')" '"ok":true'
check "oubli : réponse neutre" "$(post "$J3" forgot '{"email":"personne@example.org"}')" '"ok":true'
check "oubli" "$(post "$J3" forgot '{"email":"maman@example.org"}')" '"ok":true'
check "réinitialisation" "$(post "$J3" reset "{\"token\":\"$(lastlink reinitialiser)\",\"password\":\"reinit-123\"}")" '"ok":true'
check "lien à usage unique" "$(post "$J3" reset "{\"token\":\"$(lastlink reinitialiser)\",\"password\":\"reinit-456\"}")" 'invalide'
check "ancienne session fermée" "$(get "$J2" status)" '"user":null'
check "nouveau mot de passe" "$(post "$J2" login '{"login":"maman@example.org","password":"reinit-123"}')" '"ok":true'
check "action inconnue" "$(get "$J1" nimportequoi)" 'inconnue'

# --- RGPD : export et suppression de compte
J4=$(mktemp)
post "$J4" signup '{"email":"temp@example.org","name":"Temp","password":"motdepasse4","terms":true}' > /dev/null
post "$J4" confirm "{\"token\":\"$(lastlink confirmer)\"}" > /dev/null
check "inscription libre" "$(get "$J4" status)" '"plannings":\[\]'
post "$J4" create '{"name":"Temporaire","data":{}}' > /dev/null
check "export" "$(get "$J4" export)" '"name":"Temporaire"'
check "suppression : mot de passe exigé" "$(post "$J4" delaccount '{"password":"faux"}')" 'incorrect'
check "suppression du compte" "$(post "$J4" delaccount '{"password":"motdepasse4"}')" '"ok":true'
check "compte supprimé" "$(post "$J4" login '{"login":"temp@example.org","password":"motdepasse4"}')" 'incorrect'

# --- Notifications
check "e-mail invalide" "$(post "$J1" prefs '{"email":"pas-un-mail","prefs":{}}')" 'invalide'
check "préférences (adresse à confirmer)" "$(post "$J1" prefs '{"email":"gael@example.org","prefs":{"before":[1,7],"switch":true,"weekly":true,"changes":true}}')" '"pending":"gael@example.org"'
check "confirmation de l'adresse" "$(post "$J1" confirm "{\"token\":\"$(lastlink confirmer)\"}")" '"kind":"email"'
check "préférences relues" "$(get "$J1" prefs)" 'gael@example.org'
check "e-mail de test" "$(post "$J1" testmail '{}')" '"ok":true'
check "cron HTTP sans clé refusé" "$(get "$J1" cron)" 'refusé'
V=$(get "$J2" status | sed -E 's/.*"version":([0-9]+).*/\1/')
check "Maman modifie" "$(post "$J2" save "{\"data\":{\"rhythm\":{\"preset\":\"alt1\",\"first\":\"b\",\"ref\":\"2026-11-16\"},\"events\":[{\"id\":\"t\",\"kind\":\"trail\",\"title\":\"Trail test\",\"date\":\"2026-11-30\"}],\"overrides\":{}},\"version\":$V,\"message\":\"Ajout : Trail test\"}")" '"ok":true'
if [ -n "${ALTERPLAN_CONFIG:-}" ]; then
  # dimanche 22/11 : changement de garde le lendemain (chez Papa) ; lundi 23 : trail dans 7 jours + semaine
  check "cron dimanche" "$(php "$(dirname "$0")/../api/cron.php" today=2026-11-22 hour=8)" '"daily":2'
  check "cron une fois par jour" "$(php "$(dirname "$0")/../api/cron.php" today=2026-11-22 hour=9)" '"daily":0'
  check "cron lundi" "$(php "$(dirname "$0")/../api/cron.php" today=2026-11-23 hour=8)" '"daily":2'
  M=$(cat "$MAIL_LOG")
  check "mail de test envoyé" "$M" 'e-mail de test'
  check "résumé des modifications de Maman" "$M" 'Planning modifié par Maman'
  check "rappel de changement de garde" "$M" 'Demain, les enfants vont chez Papa'
  check "Maman : rappel « chez toi »" "$M" '"to":"maman@example.org","subject":"alterplan · Dans 7 jours'
  check "rappel d'événement à J-7" "$M" 'Dans 7 jours'
  check "résumé de la semaine" "$M" 'Ta semaine'
fi
rm -f "$J1" "$J2" "$J3" "$J4"
echo "échecs : $fails"
exit $fails
