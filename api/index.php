<?php
/* alterplan · API (PHP + MySQL sur l'hébergement OVH).
 *
 * Comptes (inscription libre avec e-mail confirmé), plusieurs plannings de garde par compte,
 * rôles par planning (admin / membre), invitations, contrôle de version, historique,
 * export et suppression des données personnelles. Les tables sont créées et migrées au premier appel.
 *
 * Configuration : api/config.php (généré au déploiement depuis les secrets GitHub, jamais versionné)
 *   return ['dsn' => 'mysql:host=…;dbname=…;charset=utf8mb4', 'user' => …, 'pass' => …, 'setup_code' => …,
 *           'mail_from' => …, 'site_url' => …, 'signup' => true, 'verify_email' => true];
 */
declare(strict_types=1);

require __DIR__ . '/planning.php';
require __DIR__ . '/notify.php';
date_default_timezone_set('Europe/Paris');
$cli = PHP_SAPI === 'cli';
if (!$cli) {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: same-origin');
}

const COOKIE = 'ap_session';
const SESSION_DAYS = 180;
const MAX_DATA = 1000000;
const HISTORY_KEEP = 300;
const MAX_PLANNINGS = 20;
const SCHEMA_VERSION = 2;

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
$signupOpen = (bool)($cfg['signup'] ?? true);
$verifyEmail = (bool)($cfg['verify_email'] ?? true);
$site = rtrim((string)($cfg['site_url'] ?? 'https://alterplan.quiquandou.fr'), '/');

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
    $db->exec("CREATE TABLE IF NOT EXISTS ap_meta (k VARCHAR(40) NOT NULL PRIMARY KEY, v VARCHAR(190) NOT NULL)$tail");
    $v = (int)($db->query("SELECT v FROM ap_meta WHERE k = 'schema'")->fetchColumn() ?: 0);
    if ($v >= SCHEMA_VERSION) return;

    $db->exec("CREATE TABLE IF NOT EXISTS ap_users (
        id $id, login VARCHAR(190) NOT NULL UNIQUE, name VARCHAR(64) NOT NULL, parent CHAR(1) NULL,
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
    $db->exec("CREATE TABLE IF NOT EXISTS ap_members (
        planning_id INT NOT NULL, user_id INT NOT NULL, role VARCHAR(10) NOT NULL DEFAULT 'member',
        parent CHAR(1) NULL, notified_version INT NULL, joined DATETIME NOT NULL,
        PRIMARY KEY (planning_id, user_id))$tail");
    $db->exec("CREATE TABLE IF NOT EXISTS ap_tokens (
        token CHAR(64) NOT NULL PRIMARY KEY, user_id INT NOT NULL, kind VARCHAR(10) NOT NULL,
        data VARCHAR(190) NULL, created DATETIME NOT NULL, expires DATETIME NOT NULL)$tail");
    // Colonnes ajoutées après coup : ignorées si elles existent déjà.
    $cols = [
        'ap_users' => ['email VARCHAR(190) NULL', 'prefs TEXT NULL', 'notified_version INT NULL', 'last_seen DATETIME NULL', 'verified TINYINT NOT NULL DEFAULT 1'],
        'ap_planning' => ['name VARCHAR(80) NULL', 'created DATETIME NULL'],
        'ap_history' => ['planning_id INT NOT NULL DEFAULT 1'],
        'ap_invites' => ['planning_id INT NOT NULL DEFAULT 1', "role VARCHAR(10) NOT NULL DEFAULT 'member'"],
    ];
    foreach ($cols as $table => $list) {
        foreach ($list as $col) {
            try { $db->exec("ALTER TABLE $table ADD COLUMN $col"); } catch (Throwable $e) { /* déjà là */ }
        }
    }
    if ($mysql) {
        try { $db->exec('ALTER TABLE ap_users MODIFY login VARCHAR(190) NOT NULL'); } catch (Throwable $e) { /* déjà fait */ }
        try { $db->exec('CREATE INDEX ap_history_planning ON ap_history (planning_id, id)'); } catch (Throwable $e) { /* déjà là */ }
    }
    // Migration du planning unique (v1) : chaque compte devient membre du planning 1, l'admin en est l'admin.
    if ((int)$db->query('SELECT COUNT(*) FROM ap_members')->fetchColumn() === 0 && $db->query('SELECT COUNT(*) FROM ap_planning WHERE id = 1')->fetchColumn()) {
        $now = gmdate('Y-m-d H:i:s');
        foreach ($db->query('SELECT id, admin, parent, notified_version, created FROM ap_users')->fetchAll() as $u) {
            $db->prepare('INSERT INTO ap_members (planning_id, user_id, role, parent, notified_version, joined) VALUES (1, ?, ?, ?, ?, ?)')
                ->execute([$u['id'], $u['admin'] ? 'admin' : 'member', $u['parent'], $u['notified_version'], $u['created'] ?: $now]);
        }
        $db->exec("UPDATE ap_planning SET name = 'Planning de garde' WHERE id = 1 AND (name IS NULL OR name = '')");
        $db->prepare('UPDATE ap_planning SET created = COALESCE(created, updated) WHERE id = 1')->execute();
    }
    $db->prepare($mysql ? 'REPLACE INTO ap_meta (k, v) VALUES (?, ?)' : 'INSERT OR REPLACE INTO ap_meta (k, v) VALUES (?, ?)')->execute(['schema', (string)SCHEMA_VERSION]);
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
$pid = (int)($_GET['p'] ?? 0);
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
$ip = substr((string)($_SERVER['REMOTE_ADDR'] ?? ''), 0, 56);
$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
$post = function () use ($method): void { if ($method !== 'POST') fail('POST attendu.', 405); };

function setCookieToken(string $value, int $expires, bool $https): void
{
    setcookie(COOKIE, $value, ['expires' => $expires, 'path' => '/', 'secure' => $https, 'httponly' => true, 'samesite' => 'Lax']);
}
function validParent($p): ?string
{
    return $p === 'a' || $p === 'b' ? $p : null;
}
function validRole($r): string
{
    return $r === 'admin' ? 'admin' : 'member';
}
function checkPassword(string $p): void
{
    if (mb_strlen($p) < 8) fail('Mot de passe trop court (8 caractères minimum).');
    if (strlen($p) > 200) fail('Mot de passe trop long.');
}
function checkLogin(string $l): string
{
    $l = mb_strtolower(trim($l));
    if (!preg_match('/^[\p{L}\p{N}._@+-]{2,64}$/u', $l)) fail('Identifiant invalide (2 à 64 caractères, sans espace).');
    return $l;
}
function checkEmail(string $e): string
{
    $e = mb_strtolower(trim($e));
    if (strlen($e) > 190 || !filter_var($e, FILTER_VALIDATE_EMAIL)) fail('Adresse e-mail invalide.');
    return $e;
}
/* Limite les essais (connexion, inscription, e-mails) : $max par quart d'heure et par IP. */
function throttle(PDO $db, string $key, int $max, string $now): void
{
    $db->prepare('DELETE FROM ap_attempts WHERE at < ?')->execute([gmdate('Y-m-d H:i:s', time() - 900)]);
    $st = $db->prepare('SELECT COUNT(*) FROM ap_attempts WHERE ip = ?');
    $st->execute([$key]);
    if ((int)$st->fetchColumn() >= $max) fail('Trop de tentatives. Réessaie dans 15 minutes.', 429);
}
function attempt(PDO $db, string $key, string $now): void
{
    $db->prepare('INSERT INTO ap_attempts (ip, at) VALUES (?, ?)')->execute([$key, $now]);
}

/* Utilisateur connecté (cookie de session). */
$user = null;
$cookie = (string)($_COOKIE[COOKIE] ?? '');
if ($cookie !== '' && preg_match('/^[a-f0-9]{64}$/', $cookie)) {
    $st = $db->prepare('SELECT u.* FROM ap_sessions s JOIN ap_users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?');
    $st->execute([$hash($cookie), $now]);
    $user = $st->fetch() ?: null;
    if ($user && ($user['last_seen'] ?? '') < gmdate('Y-m-d H:i:s', time() - 600)) {
        $db->prepare('UPDATE ap_users SET last_seen = ? WHERE id = ?')->execute([$now, $user['id']]);
    }
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

/* Plannings d'un compte : [{id, name, role, parent, notified_version}] */
function memberships(PDO $db, int $uid): array
{
    $st = $db->prepare('SELECT p.id, p.name, m.role, m.parent, m.notified_version FROM ap_members m JOIN ap_planning p ON p.id = m.planning_id WHERE m.user_id = ? ORDER BY m.joined, p.id');
    $st->execute([$uid]);
    return array_map(fn($r) => ['id' => (int)$r['id'], 'name' => (string)$r['name'], 'role' => $r['role'], 'parent' => $r['parent'], 'notified_version' => $r['notified_version']], $st->fetchAll());
}
/* Le planning demandé (?p=), ou le premier du compte si absent. */
function membership(PDO $db, int $uid, int $pid): ?array
{
    $all = memberships($db, $uid);
    if (!$all) return null;
    if ($pid === 0) return $all[0];
    foreach ($all as $m) if ($m['id'] === $pid) return $m;
    return null;
}
$needMember = function (bool $admin = false) use ($db, &$user, &$pid, $needUser): array {
    $u = $needUser();
    $m = membership($db, (int)$u['id'], $pid);
    if (!$m) fail('Planning introuvable.', 404, ['code' => 'noplanning']);
    if ($admin && $m['role'] !== 'admin') fail("Réservé aux administrateurs du planning.", 403);
    $pid = $m['id'];
    return [$u, $m];
};
function publicUser(?array $u, ?array $m = null): ?array
{
    return $u ? [
        'id' => (int)$u['id'], 'login' => $u['login'], 'name' => $u['name'], 'email' => $u['email'] ?: null,
        'parent' => $m['parent'] ?? null, 'admin' => ($m['role'] ?? '') === 'admin', 'siteAdmin' => (bool)$u['admin'],
        'notify' => !empty($u['email']),
    ] : null;
}
function planningMeta(?array $m): ?array
{
    return $m ? ['id' => $m['id'], 'name' => $m['name'], 'role' => $m['role'], 'parent' => $m['parent']] : null;
}

function planning(PDO $db, int $pid): ?array
{
    $st = $db->prepare('SELECT name, data, version, updated FROM ap_planning WHERE id = ?');
    $st->execute([$pid]);
    $row = $st->fetch();
    return $row ? ['data' => json_decode($row['data'], true), 'version' => (int)$row['version'], 'updated' => $row['updated']] : null;
}
function writePlanning(PDO $db, int $pid, array $data, int $version, ?int $userId, string $message, string $now, ?string $insertName = null): void
{
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if (strlen($json) > MAX_DATA) fail('Planning trop volumineux.', 413);
    if ($insertName !== null) {
        $db->prepare('INSERT INTO ap_planning (id, name, data, version, updated, updated_by, created) VALUES (?, ?, ?, ?, ?, ?, ?)')->execute([$pid, $insertName, $json, $version, $now, $userId, $now]);
    } else {
        $db->prepare('UPDATE ap_planning SET data = ?, version = ?, updated = ?, updated_by = ? WHERE id = ?')->execute([$json, $version, $now, $userId, $pid]);
    }
    $db->prepare('INSERT INTO ap_history (planning_id, at, user_id, version, message, data) VALUES (?, ?, ?, ?, ?, ?)')->execute([$pid, $now, $userId, $version, mb_substr($message, 0, 200), $json]);
    $st = $db->prepare('SELECT MIN(version) FROM (SELECT version FROM ap_history WHERE planning_id = ? ORDER BY id DESC LIMIT ' . HISTORY_KEEP . ') t');
    $st->execute([$pid]);
    $keep = (int)$st->fetchColumn();
    if ($keep > 0) $db->prepare('DELETE FROM ap_history WHERE planning_id = ? AND version < ?')->execute([$pid, $keep]);
}
function newPlanning(PDO $db, string $name, array $data, int $uid, ?string $parent, string $message, string $now): int
{
    $pid = (int)$db->query('SELECT COALESCE(MAX(id), 0) + 1 FROM ap_planning')->fetchColumn();
    writePlanning($db, $pid, $data, 1, $uid, $message, $now, $name);
    $db->prepare('INSERT INTO ap_members (planning_id, user_id, role, parent, notified_version, joined) VALUES (?, ?, ?, ?, 1, ?)')->execute([$pid, $uid, 'admin', $parent, $now]);
    return $pid;
}
function deletePlanning(PDO $db, int $pid): void
{
    foreach (['ap_members', 'ap_invites', 'ap_history'] as $t) $db->prepare("DELETE FROM $t WHERE planning_id = ?")->execute([$pid]);
    $db->prepare('DELETE FROM ap_planning WHERE id = ?')->execute([$pid]);
}
function addMember(PDO $db, int $pid, int $uid, string $role, ?string $parent, string $now): void
{
    $v = (int)($db->query('SELECT version FROM ap_planning WHERE id = ' . $pid)->fetchColumn() ?: 0);
    $db->prepare('INSERT INTO ap_members (planning_id, user_id, role, parent, notified_version, joined) VALUES (?, ?, ?, ?, ?, ?)')->execute([$pid, $uid, $role, $parent, $v, $now]);
}
function adminCount(PDO $db, int $pid): int
{
    $st = $db->prepare("SELECT COUNT(*) FROM ap_members WHERE planning_id = ? AND role = 'admin'");
    $st->execute([$pid]);
    return (int)$st->fetchColumn();
}
/* Invitation valide : [token, parent, role, planning_id, name (planning), from] ou null */
function invite(PDO $db, string $token, string $now, callable $hash): ?array
{
    $st = $db->prepare('SELECT i.*, p.name AS planning, u.name AS sender FROM ap_invites i JOIN ap_planning p ON p.id = i.planning_id LEFT JOIN ap_users u ON u.id = i.created_by WHERE i.token = ? AND i.used = 0 AND i.expires > ?');
    $st->execute([$hash($token), $now]);
    return $st->fetch() ?: null;
}
/* Lien envoyé par e-mail (confirmation d'adresse, mot de passe oublié). */
function mailToken(PDO $db, array $cfg, string $site, int $uid, string $kind, string $to, ?string $data, string $now, callable $hash): void
{
    $token = bin2hex(random_bytes(24));
    $hours = $kind === 'reset' ? 2 : 72;
    $db->prepare('DELETE FROM ap_tokens WHERE user_id = ? AND kind = ?')->execute([$uid, $kind]);
    $db->prepare('INSERT INTO ap_tokens (token, user_id, kind, data, created, expires) VALUES (?, ?, ?, ?, ?, ?)')
        ->execute([$hash($token), $uid, $kind, $data, $now, gmdate('Y-m-d H:i:s', time() + $hours * 3600)]);
    $db->prepare('DELETE FROM ap_tokens WHERE expires < ?')->execute([$now]);
    if ($kind === 'reset') {
        $url = "$site/?reinitialiser=$token";
        [$subject, $title, $lines, $label] = ['Nouveau mot de passe', 'Choisir un nouveau mot de passe', ['Quelqu\'un (sans doute toi) a demandé à changer le mot de passe de ton compte alterplan.', 'Le lien est valable 2 heures. Si ce n\'est pas toi, ignore cet e-mail : rien ne change.'], 'Choisir un mot de passe'];
    } else {
        $url = "$site/?confirmer=$token";
        [$subject, $title, $lines, $label] = ['Confirme ton adresse', 'Confirme ton adresse e-mail', ['Un clic pour confirmer que cette adresse est bien la tienne.', 'Le lien est valable 3 jours. Si tu n\'as rien demandé, ignore cet e-mail.'], 'Confirmer mon adresse'];
    }
    $lines[] = 'Si le bouton ne marche pas, copie ce lien : ' . ap_h($url);
    ap_sendMail($cfg, $to, "alterplan · $subject", ap_mailHtml($cfg, $title, [['', $lines]], [$label, $url]));
}
function useToken(PDO $db, string $token, array $kinds, string $now, callable $hash): ?array
{
    $st = $db->prepare('SELECT t.*, u.email FROM ap_tokens t JOIN ap_users u ON u.id = t.user_id WHERE t.token = ? AND t.expires > ?');
    $st->execute([$hash($token), $now]);
    $t = $st->fetch();
    if (!$t || !in_array($t['kind'], $kinds, true)) return null;
    $db->prepare('DELETE FROM ap_tokens WHERE token = ?')->execute([$t['token']]);
    return $t;
}
function emailTaken(PDO $db, string $email, int $exceptId = 0): bool
{
    $st = $db->prepare('SELECT COUNT(*) FROM ap_users WHERE (email = ? OR login = ?) AND id <> ?');
    $st->execute([$email, $email, $exceptId]);
    return (int)$st->fetchColumn() > 0;
}
/* Planning de départ (data.json du site) importé à l'installation, sinon vide. */
function importedData(): ?array
{
    $file = dirname(__DIR__) . '/data.json';
    $data = is_file($file) ? json_decode((string)file_get_contents($file), true) : null;
    return is_array($data) ? $data : null;
}

/* ===== Actions ===== */
switch ($action) {
    case 'status': {
        $res = ['needsSetup' => $userCount === 0, 'signup' => $signupOpen, 'user' => null];
        if ($user) {
            $all = memberships($db, (int)$user['id']);
            $m = membership($db, (int)$user['id'], $pid) ?? ($all[0] ?? null);
            $res['user'] = publicUser($user, $m);
            $res['plannings'] = array_map('planningMeta', $all);
            $res['planning'] = planningMeta($m);
            $res += ($m ? planning($db, $m['id']) : null) ?? ['data' => null, 'version' => 0];
        }
        out($res);
    }

    case 'setup': {
        $post();
        if ($userCount > 0) fail('Le premier compte existe déjà.', 409);
        $code = (string)($cfg['setup_code'] ?? '');
        if ($code === '' || !hash_equals($code, (string)($body['code'] ?? ''))) {
            attempt($db, $ip, $now);
            fail("Code d'installation incorrect.", 403);
        }
        $login = checkLogin($str('login', 64));
        $name = $str('name', 64) ?: $login;
        $pass = (string)($body['password'] ?? '');
        checkPassword($pass);
        $db->prepare('INSERT INTO ap_users (login, name, parent, pass, admin, created, verified) VALUES (?, ?, NULL, ?, 1, ?, 1)')
            ->execute([$login, $name, password_hash($pass, PASSWORD_DEFAULT), $now]);
        $uid = (int)$db->lastInsertId();
        $data = importedData();
        newPlanning($db, 'Planning de garde', $data ?? [], $uid, validParent($body['parent'] ?? null), $data ? 'Import du planning (data.json)' : 'Planning vide', $now);
        openSession($db, $uid, $now, $https, $hash);
        out(['ok' => true]);
    }

    case 'signup': {
        $post();
        $token = (string)($body['token'] ?? '');
        $inv = $token !== '' ? invite($db, $token, $now, $hash) : null;
        if ($token !== '' && !$inv) fail('Invitation invalide ou expirée.', 403);
        if (!$signupOpen && !$inv) fail("Les inscriptions sont fermées : il faut une invitation.", 403);
        throttle($db, "signup:$ip", 8, $now);
        $email = checkEmail($str('email', 190));
        $name = $str('name', 64);
        if ($name === '') fail('Indique ton prénom.');
        $pass = (string)($body['password'] ?? '');
        checkPassword($pass);
        if (empty($body['terms'])) fail("Il faut accepter les conditions d'utilisation.");
        if (emailTaken($db, $email)) fail('Un compte existe déjà avec cette adresse. Connecte-toi, ou utilise « Mot de passe oublié ».', 409);
        attempt($db, "signup:$ip", $now);
        $db->beginTransaction();
        $db->prepare('INSERT INTO ap_users (login, name, parent, pass, admin, created, email, verified) VALUES (?, ?, NULL, ?, 0, ?, ?, ?)')
            ->execute([$email, $name, password_hash($pass, PASSWORD_DEFAULT), $now, $email, $verifyEmail ? 0 : 1]);
        $uid = (int)$db->lastInsertId();
        if ($inv) {
            $db->prepare('UPDATE ap_invites SET used = 1 WHERE token = ?')->execute([$inv['token']]);
            addMember($db, (int)$inv['planning_id'], $uid, validRole($inv['role']), validParent($body['parent'] ?? null) ?? $inv['parent'], $now);
        }
        $db->commit();
        if ($verifyEmail) {
            mailToken($db, $cfg, $site, $uid, 'verify', $email, null, $now, $hash);
            out(['ok' => true, 'verify' => true, 'email' => $email]);
        }
        openSession($db, $uid, $now, $https, $hash);
        out(['ok' => true]);
    }

    case 'confirm': { // lien reçu par e-mail : confirmation d'inscription ou de nouvelle adresse
        $post();
        throttle($db, "token:$ip", 20, $now);
        $t = useToken($db, (string)($body['token'] ?? ''), ['verify', 'email'], $now, $hash);
        if (!$t) { attempt($db, "token:$ip", $now); fail('Lien invalide ou expiré.', 403); }
        if ($t['kind'] === 'email') {
            if (emailTaken($db, (string)$t['data'], (int)$t['user_id'])) fail('Cette adresse est déjà utilisée par un autre compte.', 409);
            $db->prepare('UPDATE ap_users SET email = ?, login = CASE WHEN login = email THEN ? ELSE login END WHERE id = ?')->execute([$t['data'], $t['data'], $t['user_id']]);
        }
        $db->prepare('UPDATE ap_users SET verified = 1 WHERE id = ?')->execute([$t['user_id']]);
        if (!$user || (int)$user['id'] !== (int)$t['user_id']) openSession($db, (int)$t['user_id'], $now, $https, $hash);
        out(['ok' => true, 'kind' => $t['kind']]);
    }

    case 'forgot': {
        $post();
        throttle($db, "mail:$ip", 5, $now);
        attempt($db, "mail:$ip", $now);
        $email = checkEmail($str('email', 190));
        $st = $db->prepare('SELECT id, email FROM ap_users WHERE email = ?');
        $st->execute([$email]);
        if ($u = $st->fetch()) mailToken($db, $cfg, $site, (int)$u['id'], 'reset', $u['email'], null, $now, $hash);
        out(['ok' => true]); // même réponse que l'adresse existe ou non
    }

    case 'reset': {
        $post();
        throttle($db, "token:$ip", 20, $now);
        $pass = (string)($body['password'] ?? '');
        checkPassword($pass);
        $t = useToken($db, (string)($body['token'] ?? ''), ['reset'], $now, $hash);
        if (!$t) { attempt($db, "token:$ip", $now); fail('Lien invalide ou expiré. Redemande un e-mail.', 403); }
        $db->prepare('UPDATE ap_users SET pass = ?, verified = 1 WHERE id = ?')->execute([password_hash($pass, PASSWORD_DEFAULT), $t['user_id']]);
        $db->prepare('DELETE FROM ap_sessions WHERE user_id = ?')->execute([$t['user_id']]);
        openSession($db, (int)$t['user_id'], $now, $https, $hash);
        out(['ok' => true]);
    }

    case 'login': {
        $post();
        throttle($db, $ip, 10, $now);
        $id = mb_strtolower($str('login', 190));
        $st = $db->prepare('SELECT * FROM ap_users WHERE login = ? OR email = ? ORDER BY id LIMIT 1');
        $st->execute([$id, $id]);
        $u = $st->fetch();
        if (!$u || !password_verify((string)($body['password'] ?? ''), $u['pass'])) {
            attempt($db, $ip, $now);
            usleep(400000);
            fail('Identifiant ou mot de passe incorrect.', 401);
        }
        if (!$u['verified']) {
            // Renvoie le lien de confirmation, au plus un toutes les 10 minutes.
            $st = $db->prepare("SELECT COUNT(*) FROM ap_tokens WHERE user_id = ? AND kind = 'verify' AND created > ?");
            $st->execute([$u['id'], gmdate('Y-m-d H:i:s', time() - 600)]);
            if (!(int)$st->fetchColumn() && $u['email']) mailToken($db, $cfg, $site, (int)$u['id'], 'verify', $u['email'], null, $now, $hash);
            fail("Confirme d'abord ton adresse : un lien vient de t'être envoyé à {$u['email']}.", 403, ['code' => 'unverified']);
        }
        if (password_needs_rehash($u['pass'], PASSWORD_DEFAULT)) {
            $db->prepare('UPDATE ap_users SET pass = ? WHERE id = ?')->execute([password_hash((string)$body['password'], PASSWORD_DEFAULT), $u['id']]);
        }
        openSession($db, (int)$u['id'], $now, $https, $hash);
        out(['ok' => true]);
    }

    case 'logout': {
        $post();
        if ($cookie !== '') $db->prepare('DELETE FROM ap_sessions WHERE token = ?')->execute([$hash($cookie)]);
        setCookieToken('', time() - 3600, $https);
        out(['ok' => true]);
    }

    case 'create': {
        $post();
        $u = $needUser();
        if (count(memberships($db, (int)$u['id'])) >= MAX_PLANNINGS) fail('Nombre maximum de plannings atteint (' . MAX_PLANNINGS . ').');
        $name = $str('name', 80);
        if ($name === '') fail('Donne un nom au planning.');
        $data = is_array($body['data'] ?? null) ? $body['data'] : [];
        $db->beginTransaction();
        $id = newPlanning($db, $name, $data, (int)$u['id'], validParent($body['parent'] ?? null), 'Création du planning', $now);
        $db->commit();
        out(['ok' => true, 'id' => $id]);
    }

    case 'save': {
        $post();
        [$u] = $needMember();
        if (!is_array($body['data'] ?? null)) fail('Planning manquant.');
        $db->beginTransaction();
        if ($mysql) $db->prepare('SELECT id FROM ap_planning WHERE id = ? FOR UPDATE')->execute([$pid]);
        $cur = planning($db, $pid);
        $base = (int)($body['version'] ?? -1);
        if ($base !== $cur['version']) {
            $db->rollBack();
            out(['error' => "Le planning a changé entre-temps.", 'code' => 'conflict'] + $cur, 409);
        }
        $version = $cur['version'] + 1;
        writePlanning($db, $pid, $body['data'], $version, (int)$u['id'], $str('message', 200) ?: 'Mise à jour du planning', $now);
        $db->commit();
        out(['ok' => true, 'version' => $version]);
    }

    case 'history': {
        $needMember();
        $st = $db->prepare('SELECT h.id, h.at, h.version, h.message, u.name FROM ap_history h LEFT JOIN ap_users u ON u.id = h.user_id WHERE h.planning_id = ? ORDER BY h.id DESC LIMIT 40');
        $st->execute([$pid]);
        out(['history' => $st->fetchAll()]);
    }

    case 'settings': {
        $post();
        $needMember(true);
        $name = $str('name', 80);
        if ($name === '') fail('Donne un nom au planning.');
        $db->prepare('UPDATE ap_planning SET name = ? WHERE id = ?')->execute([$name, $pid]);
        out(['ok' => true, 'name' => $name]);
    }

    case 'delplanning': {
        $post();
        [, $m] = $needMember(true);
        if (trim((string)($body['confirm'] ?? '')) !== $m['name']) fail('Recopie le nom exact du planning pour confirmer.');
        $db->beginTransaction();
        deletePlanning($db, $pid);
        $db->commit();
        out(['ok' => true]);
    }

    case 'users': {
        [$u, $m] = $needMember();
        $admin = $m['role'] === 'admin';
        $st = $db->prepare('SELECT u.id, u.login, u.name, u.email, u.created, u.last_seen, m.role, m.parent, m.joined,
            (SELECT COUNT(*) FROM ap_history h WHERE h.user_id = u.id AND h.planning_id = m.planning_id) AS edits,
            (SELECT MAX(h.at) FROM ap_history h WHERE h.user_id = u.id AND h.planning_id = m.planning_id) AS last_edit
            FROM ap_members m JOIN ap_users u ON u.id = m.user_id WHERE m.planning_id = ? ORDER BY m.joined, u.id');
        $st->execute([$pid]);
        $users = array_map(function ($r) use ($admin) {
            $x = ['id' => (int)$r['id'], 'login' => $r['login'], 'name' => $r['name'], 'parent' => $r['parent'], 'admin' => $r['role'] === 'admin', 'role' => $r['role']];
            if ($admin) $x += ['email' => $r['email'] ?: null, 'created' => $r['joined'] ?: $r['created'], 'lastSeen' => $r['last_seen'], 'edits' => (int)$r['edits'], 'lastEdit' => $r['last_edit']];
            return $x;
        }, $st->fetchAll());
        $res = ['users' => $users];
        if ($admin) {
            $st = $db->prepare('SELECT substr(token, 1, 12) AS id, parent, role, expires FROM ap_invites WHERE planning_id = ? AND used = 0 AND expires > ? ORDER BY expires');
            $st->execute([$pid, $now]);
            $res['invites'] = $st->fetchAll();
        }
        out($res);
    }

    case 'member': { // admin : changer le rôle d'un membre, ou le retirer du planning
        $post();
        [$u] = $needMember(true);
        $id = (int)($body['id'] ?? 0);
        $st = $db->prepare('SELECT role FROM ap_members WHERE planning_id = ? AND user_id = ?');
        $st->execute([$pid, $id]);
        $role = $st->fetchColumn();
        if ($role === false) fail('Membre introuvable.', 404);
        $remove = !empty($body['remove']);
        $newRole = $remove ? null : validRole($body['role'] ?? 'member');
        if ($role === 'admin' && $newRole !== 'admin' && adminCount($db, $pid) <= 1) fail('Il faut au moins un administrateur.', 409);
        if ($remove) {
            if ($id === (int)$u['id']) fail('Pour partir, utilise « Quitter ce planning ».');
            $db->prepare('DELETE FROM ap_members WHERE planning_id = ? AND user_id = ?')->execute([$pid, $id]);
        } else {
            $db->prepare('UPDATE ap_members SET role = ? WHERE planning_id = ? AND user_id = ?')->execute([$newRole, $pid, $id]);
        }
        out(['ok' => true]);
    }

    case 'leave': {
        $post();
        [$u, $m] = $needMember();
        $st = $db->prepare('SELECT COUNT(*) FROM ap_members WHERE planning_id = ?');
        $st->execute([$pid]);
        $count = (int)$st->fetchColumn();
        if ($count > 1 && $m['role'] === 'admin' && adminCount($db, $pid) <= 1) fail("Tu es le seul administrateur : nomme d'abord quelqu'un d'autre administrateur.", 409);
        $db->beginTransaction();
        if ($count <= 1) deletePlanning($db, $pid);
        else $db->prepare('DELETE FROM ap_members WHERE planning_id = ? AND user_id = ?')->execute([$pid, $u['id']]);
        $db->commit();
        out(['ok' => true, 'deleted' => $count <= 1]);
    }

    case 'invite': {
        $post();
        [$u] = $needMember(true);
        $token = bin2hex(random_bytes(24));
        $db->prepare('INSERT INTO ap_invites (token, parent, role, planning_id, created_by, expires) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([$hash($token), validParent($body['parent'] ?? null), validRole($body['role'] ?? 'member'), $pid, $u['id'], gmdate('Y-m-d H:i:s', time() + 14 * 86400)]);
        out(['token' => $token, 'days' => 14]);
    }

    case 'revoke': {
        $post();
        $needMember(true);
        $id = (string)($body['id'] ?? '');
        if (!preg_match('/^[a-f0-9]{12}$/', $id)) fail('Invitation inconnue.');
        $db->prepare('DELETE FROM ap_invites WHERE planning_id = ? AND used = 0 AND token LIKE ?')->execute([$pid, $id . '%']);
        out(['ok' => true]);
    }

    case 'inviteinfo': {
        $inv = invite($db, (string)($_GET['token'] ?? ''), $now, $hash);
        if (!$inv) out(['valid' => false]);
        $data = ap_norm(planning($db, (int)$inv['planning_id'])['data'] ?? []);
        out(['valid' => true, 'parent' => $inv['parent'], 'role' => $inv['role'], 'from' => $inv['sender'], 'planning' => $inv['planning'], 'names' => $data['names']]);
    }

    case 'join': { // compte existant qui rejoint un planning avec un lien d'invitation
        $post();
        $u = $needUser();
        $inv = invite($db, (string)($body['token'] ?? ''), $now, $hash);
        if (!$inv) fail('Invitation invalide ou expirée.', 403);
        $pid = (int)$inv['planning_id'];
        if (membership($db, (int)$u['id'], $pid)) out(['ok' => true, 'id' => $pid, 'already' => true]);
        $db->beginTransaction();
        $db->prepare('UPDATE ap_invites SET used = 1 WHERE token = ?')->execute([$inv['token']]);
        addMember($db, $pid, (int)$u['id'], validRole($inv['role']), validParent($body['parent'] ?? null) ?? $inv['parent'], $now);
        $db->commit();
        out(['ok' => true, 'id' => $pid]);
    }

    case 'password': {
        $post();
        $u = $needUser();
        if (!password_verify((string)($body['old'] ?? ''), $u['pass'])) fail('Mot de passe actuel incorrect.', 403);
        $pass = (string)($body['new'] ?? '');
        checkPassword($pass);
        $db->prepare('UPDATE ap_users SET pass = ? WHERE id = ?')->execute([password_hash($pass, PASSWORD_DEFAULT), $u['id']]);
        // Les autres appareils sont déconnectés, celui-ci reste connecté.
        $db->prepare('DELETE FROM ap_sessions WHERE user_id = ? AND token <> ?')->execute([$u['id'], $hash($cookie)]);
        out(['ok' => true]);
    }

    case 'profile': { // prénom (compte) et rôle dans le planning courant (l'un des deux parents, ou aucun)
        $post();
        $u = $needUser();
        $name = $str('name', 64) ?: $u['name'];
        $db->prepare('UPDATE ap_users SET name = ? WHERE id = ?')->execute([$name, $u['id']]);
        if (array_key_exists('parent', $body) && membership($db, (int)$u['id'], $pid)) {
            $m = membership($db, (int)$u['id'], $pid);
            $db->prepare('UPDATE ap_members SET parent = ? WHERE planning_id = ? AND user_id = ?')->execute([validParent($body['parent']), $m['id'], $u['id']]);
        }
        out(['ok' => true]);
    }

    case 'prefs': {
        $u = $needUser();
        if ($method === 'POST') {
            $email = trim((string)($body['email'] ?? ''));
            $prefs = ap_prefs($body['prefs'] ?? []);
            $pending = null;
            if ($email !== '') {
                $email = checkEmail($email);
                if ($email !== mb_strtolower((string)$u['email'])) {
                    if (emailTaken($db, $email, (int)$u['id'])) fail('Cette adresse est déjà utilisée par un autre compte.', 409);
                    if ($verifyEmail) {
                        throttle($db, "mail:$ip", 5, $now);
                        attempt($db, "mail:$ip", $now);
                        mailToken($db, $cfg, $site, (int)$u['id'], 'email', $email, $email, $now, $hash);
                        $pending = $email;
                    } else {
                        $db->prepare('UPDATE ap_users SET email = ? WHERE id = ?')->execute([$email, $u['id']]);
                    }
                }
            } elseif ($u['email'] && $u['login'] === $u['email']) {
                fail("L'adresse sert à te connecter : elle ne peut pas être vide.");
            } else {
                $db->prepare('UPDATE ap_users SET email = NULL WHERE id = ?')->execute([$u['id']]);
            }
            $db->prepare('UPDATE ap_users SET prefs = ? WHERE id = ?')->execute([json_encode($prefs), $u['id']]);
            $st = $db->prepare('SELECT email FROM ap_users WHERE id = ?');
            $st->execute([$u['id']]);
            out(['ok' => true, 'email' => (string)$st->fetchColumn(), 'pending' => $pending, 'prefs' => $prefs]);
        }
        out(['email' => $u['email'] ?? '', 'prefs' => ap_prefs($u['prefs'] ?? null)]);
    }

    case 'testmail': {
        $post();
        [$u] = $needMember();
        if (empty($u['email'])) fail("Enregistre d'abord ton adresse e-mail.");
        $p = ap_norm(planning($db, $pid)['data'] ?? []);
        $w = ap_who($p, date('Y-m-d'));
        $html = ap_mailHtml($cfg, 'E-mail de test', [['Tout fonctionne', [
            'Bonjour ' . ap_h($u['name']) . ", les rappels d'alterplan arriveront à cette adresse.",
            "Aujourd'hui, les enfants sont chez " . ap_h($p['names'][$w]) . '.',
        ]]]);
        if (!ap_sendMail($cfg, $u['email'], 'alterplan · e-mail de test', $html)) fail("L'hébergement a refusé l'envoi.", 502);
        out(['ok' => true]);
    }

    case 'export': { // RGPD : toutes les données du compte, en JSON
        $u = $needUser();
        $plans = [];
        foreach (memberships($db, (int)$u['id']) as $m) {
            $p = planning($db, $m['id']);
            $st = $db->prepare('SELECT at, version, message FROM ap_history WHERE planning_id = ? AND user_id = ? ORDER BY id');
            $st->execute([$m['id'], $u['id']]);
            $plans[] = ['name' => $m['name'], 'role' => $m['role'], 'parent' => $m['parent'], 'version' => $p['version'], 'data' => $p['data'], 'myChanges' => $st->fetchAll()];
        }
        if (!$cli) header('Content-Disposition: attachment; filename="alterplan-mes-donnees.json"');
        out(['exported' => gmdate('c'), 'account' => [
            'login' => $u['login'], 'name' => $u['name'], 'email' => $u['email'], 'created' => $u['created'],
            'lastSeen' => $u['last_seen'], 'notifications' => ap_prefs($u['prefs'] ?? null),
        ], 'plannings' => $plans]);
    }

    case 'delaccount': {
        $post();
        $u = $needUser();
        if (!password_verify((string)($body['password'] ?? ''), $u['pass'])) fail('Mot de passe incorrect.', 403);
        $uid = (int)$u['id'];
        $db->beginTransaction();
        foreach (memberships($db, $uid) as $m) {
            $st = $db->prepare('SELECT user_id, role FROM ap_members WHERE planning_id = ? AND user_id <> ? ORDER BY joined, user_id');
            $st->execute([$m['id'], $uid]);
            $others = $st->fetchAll();
            if (!$others) { deletePlanning($db, $m['id']); continue; }
            // Dernier admin : le membre le plus ancien prend le relais.
            if ($m['role'] === 'admin' && !array_filter($others, fn($o) => $o['role'] === 'admin')) {
                $db->prepare("UPDATE ap_members SET role = 'admin' WHERE planning_id = ? AND user_id = ?")->execute([$m['id'], $others[0]['user_id']]);
            }
        }
        $db->prepare('DELETE FROM ap_members WHERE user_id = ?')->execute([$uid]);
        $db->prepare('UPDATE ap_history SET user_id = NULL WHERE user_id = ?')->execute([$uid]);
        $db->prepare('UPDATE ap_planning SET updated_by = NULL WHERE updated_by = ?')->execute([$uid]);
        $db->prepare('DELETE FROM ap_invites WHERE created_by = ? AND used = 0')->execute([$uid]);
        foreach (['ap_sessions', 'ap_tokens'] as $t) $db->prepare("DELETE FROM $t WHERE user_id = ?")->execute([$uid]);
        $db->prepare('DELETE FROM ap_users WHERE id = ?')->execute([$uid]);
        $db->commit();
        setCookieToken('', time() - 3600, $https);
        out(['ok' => true]);
    }

    case 'cron': {
        // Tâche planifiée : en ligne de commande (cron OVH) ou par HTTP avec la clé cron_key.
        $key = (string)($cfg['cron_key'] ?? '');
        if (!$cli && ($key === '' || !hash_equals($key, (string)($_GET['key'] ?? '')))) fail('Accès refusé.', 403);
        $today = ap_isIso($_GET['today'] ?? null) ? $_GET['today'] : date('Y-m-d');
        $hour = isset($_GET['hour']) ? (int)$_GET['hour'] : (int)date('G');
        $db->prepare('DELETE FROM ap_tokens WHERE expires < ?')->execute([$now]);
        out(['ok' => true, 'today' => $today] + ap_runNotifications($db, $cfg, $today, $hour, !empty($_GET['force'])));
    }

    default:
        fail('Action inconnue.', 404);
}
