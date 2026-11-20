<?php
/* alterplan · e-mails : rappels du jour (événements, changement de garde, semaine à venir)
 * et résumé des modifications faites par les autres comptes. Appelé par la tâche planifiée. */
declare(strict_types=1);

const AP_DEFAULT_PREFS = ['before' => [1, 7], 'switch' => true, 'weekly' => true, 'changes' => true];

function ap_prefs($raw): array
{
    $p = is_array($raw) ? $raw : (json_decode((string)$raw, true) ?: []);
    $before = array_values(array_unique(array_filter(array_map('intval', (array)($p['before'] ?? AP_DEFAULT_PREFS['before'])), fn($n) => in_array($n, [0, 1, 2, 3, 7, 14], true))));
    sort($before);
    return [
        'before' => $before,
        'switch' => (bool)($p['switch'] ?? true),
        'weekly' => (bool)($p['weekly'] ?? true),
        'changes' => (bool)($p['changes'] ?? true),
    ];
}

function ap_h(string $s): string { return htmlspecialchars($s, ENT_QUOTES, 'UTF-8'); }

/* Gabarit commun des e-mails. $blocks : [[titre, [lignes html]]] */
function ap_mailHtml(array $cfg, string $title, array $blocks): string
{
    $url = ap_h($cfg['site_url'] ?? 'https://alterplan.quiquandou.fr');
    $html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#16181a">'
        . '<p style="margin:0 0 4px;font-size:13px;color:#6b7075;letter-spacing:.5px;text-transform:uppercase">alterplan</p>'
        . '<h1 style="margin:0 0 16px;font-size:22px">' . ap_h($title) . '</h1>';
    foreach ($blocks as [$h, $lines]) {
        $html .= '<h2 style="margin:18px 0 8px;font-size:15px;color:#3f4448">' . ap_h($h) . '</h2><ul style="margin:0;padding-left:18px;line-height:1.6">';
        foreach ($lines as $l) $html .= "<li>$l</li>";
        $html .= '</ul>';
    }
    return $html . '<p style="margin:24px 0 0"><a href="' . $url . '" style="display:inline-block;background:#16181a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px">Ouvrir le planning</a></p>'
        . '<p style="margin:20px 0 0;font-size:12px;color:#6b7075">Pour changer ces e-mails : Réglages › Compte › Notifications.</p></div>';
}

function ap_sendMail(array $cfg, string $to, string $subject, string $html): bool
{
    $from = (string)($cfg['mail_from'] ?? 'alterplan@quiquandou.fr');
    $text = trim(html_entity_decode(strip_tags(str_replace(['</li>', '</h1>', '</h2>', '</p>'], "\n", $html)), ENT_QUOTES, 'UTF-8'));
    if (!empty($cfg['mail_log'])) { // tests : on écrit au lieu d'envoyer
        file_put_contents($cfg['mail_log'], json_encode(['to' => $to, 'subject' => $subject, 'text' => $text], JSON_UNESCAPED_UNICODE) . "\n", FILE_APPEND);
        return true;
    }
    $boundary = 'ap' . bin2hex(random_bytes(8));
    $headers = implode("\r\n", [
        'From: alterplan <' . $from . '>',
        'Reply-To: ' . $from,
        'MIME-Version: 1.0',
        "Content-Type: multipart/alternative; boundary=\"$boundary\"",
    ]);
    $body = "--$boundary\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($text))
        . "--$boundary\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($html))
        . "--$boundary--\r\n";
    return mail($to, mb_encode_mimeheader($subject, 'UTF-8', 'B'), $body, $headers, '-f' . $from);
}

/* Rappels du jour pour un compte : [sujet, blocs] ou null s'il n'y a rien à dire. */
function ap_daily(array $p, array $user, array $prefs, string $today): ?array
{
    $names = $p['names'];
    $mine = $user['parent'] ?? null;
    $blocks = [];
    $subject = null;
    $chez = fn(string $w): string => $mine === $w ? 'chez toi' : 'chez ' . $names[$w];

    if ($prefs['switch']) {
        $tomorrow = ap_add($today, 1);
        $w0 = ap_who($p, $today);
        $w1 = ap_who($p, $tomorrow);
        if ($w0 !== $w1) {
            $line = 'Demain, ' . ap_longDate($tomorrow) . ', les enfants passent <strong>' . ap_h($chez($w1)) . '</strong>.';
            if ($note = ap_note($p, $tomorrow)) $line .= ' <em>(' . ap_h($note) . ')</em>';
            $blocks[] = ['Changement de garde', [$line]];
            $subject = 'Demain, les enfants vont ' . $chez($w1);
        }
    }
    $lines = [];
    foreach ($prefs['before'] as $off) {
        $d = ap_add($today, $off);
        foreach (ap_events($p, $d) as $e) {
            if (isset($e['start']) && !$e['start']) continue; // événement sur plusieurs jours : rappel du premier jour seulement
            $when = $off === 0 ? "Aujourd'hui" : ($off === 1 ? 'Demain' : "Dans $off jours");
            $lines[] = "$when (" . ap_h(ap_longDate($d)) . ') : <strong>' . ap_h(ap_eventLabel($e)) . '</strong> · enfants ' . ap_h($chez(ap_who($p, $d)));
            $subject = $subject ?? "$when : " . ap_eventLabel($e);
        }
    }
    if ($lines) $blocks[] = ['Événements', $lines];
    if ($prefs['weekly'] && ap_dow($today) === 0) {
        $week = [];
        for ($i = 0; $i < 7; $i++) {
            $d = ap_add($today, $i);
            $ev = array_map('ap_eventLabel', ap_events($p, $d));
            $week[] = ucfirst(ap_h(ap_longDate($d))) . ' : ' . ap_h($chez(ap_who($p, $d))) . ($ev ? ' · ' . ap_h(implode(', ', $ev)) : '');
        }
        $blocks[] = ['Ta semaine', $week];
        $subject = $subject ?? 'Ta semaine du ' . ap_longDate($today);
    }
    return $blocks ? [$subject, $blocks] : null;
}

/* Tâche planifiée : à lancer toutes les heures (ou une fois par jour, après 7 h). */
function ap_runNotifications(PDO $db, array $cfg, string $today, int $hour, bool $force = false): array
{
    $stats = ['daily' => 0, 'changes' => 0];
    $row = $db->query('SELECT data, version FROM ap_planning WHERE id = 1')->fetch();
    if (!$row) return $stats;
    $p = ap_norm(json_decode($row['data'], true));
    $current = (int)$row['version'];
    $users = $db->query("SELECT id, name, parent, email, prefs, notified_version FROM ap_users WHERE email IS NOT NULL AND email <> ''")->fetchAll();
    $title = fn(string $s): string => 'alterplan · ' . $s;
    foreach ($users as $u) {
        $prefs = ap_prefs($u['prefs']);
        // Modifications faites par les autres depuis le dernier passage.
        $seen = $u['notified_version'] === null ? $current : (int)$u['notified_version'];
        if ($prefs['changes'] && $current > $seen) {
            $st = $db->prepare('SELECT h.at, h.message, u.name FROM ap_history h LEFT JOIN ap_users u ON u.id = h.user_id WHERE h.version > ? AND (h.user_id IS NULL OR h.user_id <> ?) ORDER BY h.id LIMIT 30');
            $st->execute([$seen, $u['id']]);
            $rows = $st->fetchAll();
            if ($rows) {
                $who = implode(', ', array_unique(array_map(fn($r) => $r['name'] ?: '?', $rows)));
                $lines = array_map(fn($r) => '<strong>' . ap_h($r['name'] ?: '?') . '</strong> : ' . ap_h($r['message']), $rows);
                ap_sendMail($cfg, $u['email'], $title("Planning modifié par $who"), ap_mailHtml($cfg, "Planning modifié par $who", [['Modifications', $lines]]));
                $stats['changes']++;
            }
        }
        if ($current !== $seen || $u['notified_version'] === null) $db->prepare('UPDATE ap_users SET notified_version = ? WHERE id = ?')->execute([$current, $u['id']]);

        // Rappels du jour, une fois par jour à partir de 7 h.
        if ($hour < 7 && !$force) continue;
        $key = "daily:{$u['id']}:$today";
        $st = $db->prepare('SELECT COUNT(*) FROM ap_sent WHERE k = ?');
        $st->execute([$key]);
        if ((int)$st->fetchColumn()) continue;
        $db->prepare('INSERT INTO ap_sent (k, at) VALUES (?, ?)')->execute([$key, gmdate('Y-m-d H:i:s')]);
        $daily = ap_daily($p, $u, $prefs, $today);
        if ($daily) {
            ap_sendMail($cfg, $u['email'], $title($daily[0]), ap_mailHtml($cfg, $daily[0], $daily[1]));
            $stats['daily']++;
        }
    }
    $db->prepare('DELETE FROM ap_sent WHERE at < ?')->execute([gmdate('Y-m-d H:i:s', time() - 40 * 86400)]);
    return $stats;
}
