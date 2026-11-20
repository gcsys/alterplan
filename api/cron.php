<?php
/* alterplan · tâche planifiée (OVH › Hébergement › Tâches planifiées - Cron).
 * Chemin à indiquer : <dossier du site>/api/cron.php, langage PHP 8, fréquence : toutes les heures.
 * Envoie les rappels du jour (à partir de 7 h) et les résumés de modifications. */
if (PHP_SAPI !== 'cli') { http_response_code(403); exit; }
$_GET = ['a' => 'cron'];
foreach (array_slice($argv ?? [], 1) as $arg) { // tests : today=AAAA-MM-JJ hour=8 force=1
    [$k, $v] = array_pad(explode('=', $arg, 2), 2, '');
    if (in_array($k, ['today', 'hour', 'force'], true)) $_GET[$k] = $v;
}
$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/index.php';
