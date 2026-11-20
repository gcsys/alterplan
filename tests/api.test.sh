#!/usr/bin/env bash
# Test de bout en bout de l'API PHP (base SQLite jetable).
# Usage : tests/api.test.sh http://127.0.0.1:8770   (serveur lancé avec ALTERPLAN_CONFIG pointant vers une config SQLite)
set -u
B="${1:-http://127.0.0.1:8770}/api/index.php"
J1=$(mktemp) J2=$(mktemp)
fails=0
check() { if echo "$2" | grep -q -- "$3"; then echo "ok   - $1"; else echo "FAIL - $1 : $2"; fails=$((fails+1)); fi; }
post() { curl -s -b "$1" -c "$1" -H 'X-Alterplan: 1' -H 'Content-Type: application/json' -X POST "$B?a=$2" -d "$3"; }
get() { curl -s -b "$1" -c "$1" "$B?a=$2"; }

check "installation demandée" "$(get "$J1" status)" '"needsSetup":true'
check "sans en-tête : refusé" "$(curl -s -X POST "$B?a=setup" -d '{}')" 'Requête refusée'
check "mauvais code" "$(post "$J1" setup '{"code":"x","login":"gael","password":"motdepasse1"}')" 'incorrect'
check "mot de passe court" "$(post "$J1" setup '{"code":"secret-code","login":"gael","password":"court"}')" 'trop court'
check "premier compte" "$(post "$J1" setup '{"code":"secret-code","login":"Gael","name":"Gaël","password":"motdepasse1","parent":"a"}')" '"ok":true'
S=$(get "$J1" status)
check "connecté + planning importé" "$S" '"login":"gael"'
check "planning version 1" "$S" '"version":1'
check "second setup refusé" "$(post "$J2" setup '{"code":"secret-code","login":"x","password":"motdepasse1"}')" 'existe déjà'
check "anonyme : pas de planning" "$(get "$J2" status)" '"user":null'
check "anonyme : save refusé" "$(post "$J2" save '{"data":{},"version":1}')" 'Connexion nécessaire'
check "enregistrement" "$(post "$J1" save '{"data":{"overrides":{"2026-12-24":{"w":"b"}}},"version":1,"message":"Noël"}')" '"version":2'
C=$(post "$J1" save '{"data":{"overrides":{}},"version":1}')
check "conflit de version" "$C" '"code":"conflict"'
check "conflit renvoie la version courante" "$C" '2026-12-24'
INV=$(post "$J1" invite '{"parent":"b"}')
TOKEN=$(echo "$INV" | sed -E 's/.*"token":"([a-f0-9]+)".*/\1/')
check "invitation" "$INV" '"token"'
check "infos invitation" "$(get "$J2" "inviteinfo&token=$TOKEN")" '"valid":true'
check "inscription" "$(post "$J2" register "{\"token\":\"$TOKEN\",\"login\":\"maman\",\"name\":\"Maman\",\"password\":\"motdepasse2\"}")" '"ok":true'
check "invitation à usage unique" "$(post "$J2" register "{\"token\":\"$TOKEN\",\"login\":\"autre\",\"password\":\"motdepasse2\"}")" 'invalide'
check "Maman voit le planning" "$(get "$J2" status)" '"parent":"b"'
check "Maman ne peut pas inviter" "$(post "$J2" invite '{}')" 'administrateur'
check "liste des comptes" "$(get "$J1" users)" '"maman"'
check "historique" "$(get "$J1" history)" 'Noël'
check "déconnexion" "$(post "$J2" logout '{}')" '"ok":true'
check "déconnecté" "$(get "$J2" status)" '"user":null'
check "mauvais mot de passe" "$(post "$J2" login '{"login":"maman","password":"faux12345"}')" 'incorrect'
check "connexion" "$(post "$J2" login '{"login":"MAMAN","password":"motdepasse2"}')" '"ok":true'
check "changement de mot de passe" "$(post "$J2" password '{"old":"motdepasse2","new":"nouveau-mdp"}')" '"ok":true'
check "action inconnue" "$(get "$J1" nimportequoi)" 'inconnue'
rm -f "$J1" "$J2"
echo "échecs : $fails"
exit $fails
