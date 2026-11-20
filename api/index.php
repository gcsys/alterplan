<?php
/* alterplan · API (PHP + MySQL sur l'hébergement OVH).
 *
 * Comptes des parents, connexion par cookie, planning partagé avec contrôle de version,
 * historique des modifications. Les tables sont créées au premier appel ; le planning existant
 * (data.json à côté du site) est importé à la création du premier compte.
 *
 * Configuration : api/config.php (généré au déploiement depuis les secrets GitHub, jamais versionné)
 *   return ['dsn' => 'mysql:host=…;dbname=…;charset=utf8mb4', 'user' => …, 'pass' => …, 'setup_code' => …];
 */
declare(strict_types=1);

require __DIR__ . '/planning.php';
require __DIR__ . '/notify.php';
date_default_timezone_set('Europe/Paris');
$cli = PHP_SAPI === 'cli';
if (!$cli) header('Content-Type: application/json; charset=utf-8');
if (!$cli) {
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: same-origin');
}

const COOKIE = 'ap_session';
const SESSION_DAYS = 180;
const MAX_DATA = 1000000;
const HISTORY_KEEP = 300;

function out(array $body, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function fail(string $msg, int $code = 400, array $extra = []): void
{
    out(['error' => $msg] + $extra, $code);
}

$cfgFile = getenv('ALTERPLAN_CONFIG') ?: __DIR__ . '/config.php';
if (!is_file($cfgFile)) fail('API non configurée (config.php absent).', 503, ['code' => 'noconfig']);
$cfg = require $cfgFile;

try {
    $db = new PDO($cfg['dsn'], $cfg['user'] ?? null, $cfg['pass'] ?? null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
} catch (Throwable $e) {
    fail('Connexion à la base impossible.', 503, ['code' => 'nodb']);
}
$mysql = $db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql';

/* ===== Schéma ===== */
function schema(PDO $db, bool $mysql): void
{
    $id = $mysql ? 'INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    $tail = $mysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' : '';
    $text = $mysql ? 'MEDIUMTEXT' : 'TEXT';
    $db->exec("CREATE TABLE IF NOT EXISTS ap_users (
        id $id, login VARCHAR(64) NOT NULL UNIQUE, name VARCHAR(64) NOT NULL, parent CHAR(1) NULL,
        pass VARCHAR(255) NOT NULL, admin TINYINT NOT NULL DEFAULT 0, created DATETIME NOT NULL)$tail");
    $db->exec("CREATE TABLE IF NOT EXISTS ap_sessions (
        token CHAR(64) NOT NULL PRIMARY KEY, user_id INT NOT NULL, expires DATETIME NOT NULL)$tail");
    $db->exec("CREATE TABLE IF NOT EXISTS ap_planning (
        id INT NOT NULL PRIMARY KEY, data $text NOT NULL, version INT NOT NULL,
        updated DATETIME NOT NULL, updated_by INT NULL)$tail");
    $db->exec("CREATE TABLE IF NOT EXISTS ap_history (
        id $id, at DATETIME NOT NULL, user_id INT NULL, version INT NOT NULL,
        message VARCHAR(200) NOT NULL, data $text NOT NULL)$tail");
    $db->exec("CREATE TABLE IF NOT EXISTS ap_invites (
        token CHAR(64) NOT NULL PRIMARY KEY, parent CHAR(1) NULL, created_by INT NOT NULL,
        expires DATETIME NOT NULL, used TINYINT NOT NULL DEFAULT 0)$tail");
    $db->exec("CREATE TABLE IF NOT EXISTS ap_attempts (ip VARCHAR(64) NOT NULL, at DATETIME NOT NULL)$tail");
    $db->exec("CREATE TABLE IF NOT EXISTS ap_sent (k VARCHAR(190) NOT NULL PRIMARY KEY, at DATETIME NOT NULL)$tail");
    // Colonnes ajoutées après coup (notifications) : ignorées si elles existent déjà.
    foreach (['email VARCHAR(190) NULL', 'prefs TEXT NULL', 'notified_version INT NULL'] as $col) {
        try { $db->exec("ALTER TABLE ap_users ADD COLUMN $col"); } catch (Throwable $e) { /* déjà là */ }
    }
}
try {
    schema($db, $mysql);
} catch (Throwable $e) {
    fail('Création des tables impossible.', 503, ['code' => 'noschema']);
}

/* ===== Outils ===== */
$now = gmdate('Y-m-d H:i:s');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = (string)($_GET['a'] ?? 'status');
$body = [];
if ($method === 'POST') {
    // En-tête maison obligatoire : un autre site ne peut pas l'envoyer sans autorisation CORS.
    if (($_SERVER['HTTP_X_ALTERPLAN'] ?? '') !== '1') fail('Requête refusée.', 403);
    $raw = file_get_contents('php://input') ?: '';
    if (strlen($raw) > MAX_DATA + 10000) fail('Requête trop volumineuse.', 413);
    $body = json_decode($raw, true);
    if (!is_array($body)) $body = [];
}
$str = fn(string $k, int $max = 200): string => mb_substr(trim((string)($body[$k] ?? '')), 0, $max);
$hash = fn(string $t): string => hash('sha256', $t);
$ip = substr((string)($_SERVER['REMOTE_ADDR'] ?? ''), 0, 64);
$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');

function setCookieToken(string $value, int $expires, bool $https): void
{
    setcookie(COOKIE, $value, ['expires' => $expires, 'path' => '/', 'secure' => $https, 'httponly' => true, 'samesite' => 'Lax']);
}
function publicUser(?array $u): ?array
{
    return $u ? ['id' => (int)$u['id'], 'login' => $u['login'], 'name' => $u['name'], 'parent' => $u['parent'], 'admin' => (bool)$u['admin'], 'notify' => !empty($u['email'])] : null;
}
function validParent($p): ?string
{
    return $p === 'a' || $p === 'b' ? $p : null;
}
function checkPassword(string $p): void
{
    if (mb_strlen($p) < 8) fail('Mot de passe trop court (8 caractères minimum).');
    if (strlen($p) > 200) fail('Mot de passe trop long.');
}
function checkLogin(string $l): string
{
    $l = mb_strtolower(trim($l));
    if (!preg_match('/^[\p{L}\p{N}._@-]{2,64}$/u', $l)) fail('Identifiant invalide (2 à 64 caractères, sans espace).');
    return $l;
}

/* Utilisateur connecté (cookie de session). */
$user = null;
$cookie = (string)($_COOKIE[COOKIE] ?? '');
if ($cookie !== '' && preg_match('/^[a-f0-9]{64}$/', $cookie)) {
    $st = $db->prepare('SELECT u.* FROM ap_sessions s JOIN ap_users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?');
    $st->execute([$hash($cookie), $now]);
    $user = $st->fetch() ?: null;
}
function openSession(PDO $db, int $userId, string $now, bool $https, callable $hash): void
{
    $token = bin2hex(random_bytes(32));
    $exp = time() + SESSION_DAYS * 86400;
    $db->prepare('INSERT INTO ap_sessions (token, user_id, expires) VALUES (?, ?, ?)')->execute([$hash($token), $userId, gmdate('Y-m-d H:i:s', $exp)]);
    $db->prepare('DELETE FROM ap_sessions WHERE expires < ?')->execute([$now]);
    setCookieToken($token, $exp, $https);
}
$userCount = (int)$db->query('SELECT COUNT(*) FROM ap_users')->fetchColumn();
$needUser = function () use (&$user): array {
    if (!$user) fail('Connexion nécessaire.', 401, ['code' => 'auth']);
    return $user;
};

function planning(PDO $db): ?array
{
    $row = $db->query('SELECT data, version, updated FROM ap_planning WHERE id = 1')->fetch();
    return $row ? ['data' => json_decode($row['data'], true), 'version' => (int)$row['version'], 'updated' => $row['updated']] : null;
}
function writePlanning(PDO $db, array $data, int $version, ?int $userId, string $message, string $now, bool $insert): void
{
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if (strlen($json) > MAX_DATA) fail('Planning trop volumineux.', 413);
    if ($insert) {
        $db->prepare('INSERT INTO ap_planning (id, data, version, updated, updated_by) VALUES (1, ?, ?, ?, ?)')->execute([$json, $version, $now, $userId]);
    } else {
        $db->prepare('UPDATE ap_planning SET data = ?, version = ?, updated = ?, updated_by = ? WHERE id = 1')->execute([$json, $version, $now, $userId]);
    }
    $db->prepare('INSERT INTO ap_history (at, user_id, version, message, data) VALUES (?, ?, ?, ?, ?)')->execute([$now, $userId, $version, mb_substr($message, 0, 200), $json]);
    $keep = (int)$db->query('SELECT MIN(version) FROM (SELECT version FROM ap_history ORDER BY id DESC LIMIT ' . HISTORY_KEEP . ') t')->fetchColumn();
    if ($keep > 0) $db->prepare('DELETE FROM ap_history WHERE version < ?')->execute([$keep]);
}
/* Planning importé à la création du premier compte : data.json du site, sinon vide. */
function importPlanning(PDO $db, ?int $userId, string $now): void
{
    if (planning($db)) return;
    $file = dirname(__DIR__) . '/data.json';
    $data = is_file($file) ? json_decode((string)file_get_contents($file), true) : null;
    $ok = is_array($data);
    writePlanning($db, $ok ? $data : [], 1, $userId, $ok ? 'Import du planning (data.json)' : 'Planning vide', $now, true);
}

/* ===== Actions ===== */
switch ($action) {
    case 'status': {
        $res = ['needsSetup' => $userCount === 0, 'user' => publicUser($user)];
        if ($user) $res += planning($db) ?? ['data' => null, 'version' => 0];
        out($res);
    }

    case 'setup': {
        if ($method !== 'POST') fail('POST attendu.', 405);
        if ($userCount > 0) fail('Le premier compte existe déjà.', 409);
        $code = (string)($cfg['setup_code'] ?? '');
        if ($code === '' || !hash_equals($code, (string)($body['code'] ?? ''))) {
            $db->prepare('INSERT INTO ap_attempts (ip, at) VALUES (?, ?)')->execute([$ip, $now]);
            fail("Code d'installation incorrect.", 403);
        }
        $login = checkLogin($str('login', 64));
        $name = $str('name', 64) ?: $login;
        $pass = (string)($body['password'] ?? '');
        checkPassword($pass);
        $db->prepare('INSERT INTO ap_users (login, name, parent, pass, admin, created) VALUES (?, ?, ?, ?, 1, ?)')
            ->execute([$login, $name, validParent($body['parent'] ?? null), password_hash($pass, PASSWORD_DEFAULT), $now]);
        $uid = (int)$db->lastInsertId();
        importPlanning($db, $uid, $now);
        openSession($db, $uid, $now, $https, $hash);
        out(['ok' => true]);
    }

    case 'login': {
        if ($method !== 'POST') fail('POST attendu.', 405);
        $since = gmdate('Y-m-d H:i:s', time() - 900);
        $db->prepare('DELETE FROM ap_attempts WHERE at < ?')->execute([$since]);
        $st = $db->prepare('SELECT COUNT(*) FROM ap_attempts WHERE ip = ?');
        $st->execute([$ip]);
        if ((int)$st->fetchColumn() >= 10) fail('Trop de tentatives. Réessaie dans 15 minutes.', 429);
        $st = $db->prepare('SELECT * FROM ap_users WHERE login = ?');
        $st->execute([mb_strtolower($str('login', 64))]);
        $u = $st->fetch();
        if (!$u || !password_verify((string)($body['password'] ?? ''), $u['pass'])) {
            $db->prepare('INSERT INTO ap_attempts (ip, at) VALUES (?, ?)')->execute([$ip, $now]);
            usleep(400000);
            fail('Identifiant ou mot de passe incorrect.', 401);
        }
        if (password_needs_rehash($u['pass'], PASSWORD_DEFAULT)) {
            $db->prepare('UPDATE ap_users SET pass = ? WHERE id = ?')->execute([password_hash((string)$body['password'], PASSWORD_DEFAULT), $u['id']]);
        }
        openSession($db, (int)$u['id'], $now, $https, $hash);
        out(['ok' => true]);
    }

    case 'logout': {
        if ($method !== 'POST') fail('POST attendu.', 405);
        if ($cookie !== '') $db->prepare('DELETE FROM ap_sessions WHERE token = ?')->execute([$hash($cookie)]);
        setCookieToken('', time() - 3600, $https);
        out(['ok' => true]);
    }

    case 'save': {
        if ($method !== 'POST') fail('POST attendu.', 405);
        $u = $needUser();
        if (!is_array($body['data'] ?? null)) fail('Planning manquant.');
        $db->beginTransaction();
        $cur = planning($db);
        $base = (int)($body['version'] ?? -1);
        if ($cur && $base !== $cur['version']) {
            $db->rollBack();
            out(['error' => "Le planning a changé entre-temps.", 'code' => 'conflict'] + $cur, 409);
        }
        $version = ($cur['version'] ?? 0) + 1;
        writePlanning($db, $body['data'], $version, (int)$u['id'], $str('message', 200) ?: 'Mise à jour du planning', $now, !$cur);
        $db->commit();
        out(['ok' => true, 'version' => $version]);
    }

    case 'history': {
        $needUser();
        $rows = $db->query('SELECT h.id, h.at, h.version, h.message, u.name FROM ap_history h LEFT JOIN ap_users u ON u.id = h.user_id ORDER BY h.id DESC LIMIT 40')->fetchAll();
        out(['history' => $rows]);
    }

    case 'users': {
        $needUser();
        $rows = $db->query('SELECT id, login, name, parent, admin FROM ap_users ORDER BY id')->fetchAll();
        out(['users' => array_map('publicUser', $rows)]);
    }

    case 'invite': {
        if ($method !== 'POST') fail('POST attendu.', 405);
        $u = $needUser();
        if (!$u['admin']) fail("Seul l'administrateur peut inviter.", 403);
        $token = bin2hex(random_bytes(24));
        $db->prepare('INSERT INTO ap_invites (token, parent, created_by, expires) VALUES (?, ?, ?, ?)')
            ->execute([$hash($token), validParent($body['parent'] ?? null), $u['id'], gmdate('Y-m-d H:i:s', time() + 14 * 86400)]);
        out(['token' => $token, 'days' => 14]);
    }

    case 'inviteinfo': {
        $st = $db->prepare('SELECT i.parent, u.name FROM ap_invites i JOIN ap_users u ON u.id = i.created_by WHERE i.token = ? AND i.used = 0 AND i.expires > ?');
        $st->execute([$hash((string)($_GET['token'] ?? '')), $now]);
        $row = $st->fetch();
        out($row ? ['valid' => true, 'parent' => $row['parent'], 'from' => $row['name']] : ['valid' => false]);
    }

    case 'register': {
        if ($method !== 'POST') fail('POST attendu.', 405);
        $st = $db->prepare('SELECT * FROM ap_invites WHERE token = ? AND used = 0 AND expires > ?');
        $st->execute([$hash((string)($body['token'] ?? '')), $now]);
        $inv = $st->fetch();
        if (!$inv) fail('Invitation invalide ou expirée.', 403);
        $login = checkLogin($str('login', 64));
        $pass = (string)($body['password'] ?? '');
        checkPassword($pass);
        $st = $db->prepare('SELECT COUNT(*) FROM ap_users WHERE login = ?');
        $st->execute([$login]);
        if ((int)$st->fetchColumn()) fail('Cet identifiant est déjà pris.', 409);
        $db->beginTransaction();
        $db->prepare('UPDATE ap_invites SET used = 1 WHERE token = ?')->execute([$inv['token']]);
        $db->prepare('INSERT INTO ap_users (login, name, parent, pass, admin, created) VALUES (?, ?, ?, ?, 0, ?)')
            ->execute([$login, $str('name', 64) ?: $login, validParent($body['parent'] ?? null) ?? $inv['parent'], password_hash($pass, PASSWORD_DEFAULT), $now]);
        $uid = (int)$db->lastInsertId();
        $db->commit();
        openSession($db, $uid, $now, $https, $hash);
        out(['ok' => true]);
    }

    case 'password': {
        if ($method !== 'POST') fail('POST attendu.', 405);
        $u = $needUser();
        if (!password_verify((string)($body['old'] ?? ''), $u['pass'])) fail('Mot de passe actuel incorrect.', 403);
        $pass = (string)($body['new'] ?? '');
        checkPassword($pass);
        $db->prepare('UPDATE ap_users SET pass = ? WHERE id = ?')->execute([password_hash($pass, PASSWORD_DEFAULT), $u['id']]);
        // Les autres appareils sont déconnectés, celui-ci reste connecté.
        $db->prepare('DELETE FROM ap_sessions WHERE user_id = ? AND token <> ?')->execute([$u['id'], $hash($cookie)]);
        out(['ok' => true]);
    }

    case 'profile': {
        if ($method !== 'POST') fail('POST attendu.', 405);
        $u = $needUser();
        $name = $str('name', 64) ?: $u['name'];
        $db->prepare('UPDATE ap_users SET name = ?, parent = ? WHERE id = ?')->execute([$name, validParent($body['parent'] ?? null), $u['id']]);
        out(['ok' => true]);
    }

    case 'deluser': {
        if ($method !== 'POST') fail('POST attendu.', 405);
        $u = $needUser();
        $id = (int)($body['id'] ?? 0);
        if (!$u['admin'] || $id === (int)$u['id']) fail('Suppression refusée.', 403);
        $db->prepare('DELETE FROM ap_sessions WHERE user_id = ?')->execute([$id]);
        $db->prepare('DELETE FROM ap_users WHERE id = ?')->execute([$id]);
        out(['ok' => true]);
    }

    case 'prefs': {
        $u = $needUser();
        if ($method === 'POST') {
            $email = trim((string)($body['email'] ?? ''));
            if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) fail('Adresse e-mail invalide.');
            $prefs = ap_prefs($body['prefs'] ?? []);
            $cur = planning($db);
            $db->prepare('UPDATE ap_users SET email = ?, prefs = ?, notified_version = COALESCE(notified_version, ?) WHERE id = ?')
                ->execute([$email ?: null, json_encode($prefs), $cur['version'] ?? 0, $u['id']]);
            out(['ok' => true, 'email' => $email, 'prefs' => $prefs]);
        }
        out(['email' => $u['email'] ?? '', 'prefs' => ap_prefs($u['prefs'] ?? null)]);
    }

    case 'testmail': {
        if ($method !== 'POST') fail('POST attendu.', 405);
        $u = $needUser();
        if (empty($u['email'])) fail("Enregistre d'abord ton adresse e-mail.");
        $p = ap_norm(planning($db)['data'] ?? []);
        $today = date('Y-m-d');
        $w = ap_who($p, $today);
        $html = ap_mailHtml($cfg, 'E-mail de test', [['Tout fonctionne', [
            "Bonjour {$u['name']}, les rappels d'alterplan arriveront à cette adresse.",
            "Aujourd'hui, les enfants sont chez " . ap_h($p['names'][$w]) . '.',
        ]]]);
        if (!ap_sendMail($cfg, $u['email'], 'alterplan · e-mail de test', $html)) fail("L'hébergement a refusé l'envoi.", 502);
        out(['ok' => true]);
    }

    case 'cron': {
        // Tâche planifiée : en ligne de commande (cron OVH) ou par HTTP avec la clé cron_key.
        $key = (string)($cfg['cron_key'] ?? '');
        if (!$cli && ($key === '' || !hash_equals($key, (string)($_GET['key'] ?? '')))) fail('Accès refusé.', 403);
        $today = ap_isIso($_GET['today'] ?? null) ? $_GET['today'] : date('Y-m-d');
        $hour = isset($_GET['hour']) ? (int)$_GET['hour'] : (int)date('G');
        out(['ok' => true, 'today' => $today] + ap_runNotifications($db, $cfg, $today, $hour, !empty($_GET['force'])));
    }

    default:
        fail('Action inconnue.', 404);
}
