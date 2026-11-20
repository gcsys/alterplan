<?php
/* alterplan · calcul du planning côté serveur (même logique que planning.js) :
 * chez qui sont les enfants un jour donné, et les événements du jour. Sert aux e-mails. */
declare(strict_types=1);

const AP_PRESETS = [
    'alt1' => ['days' => 'FFFFFFFOOOOOOO', 'monday' => false],
    'alt2' => ['days' => 'FFFFFFFFFFFFFFOOOOOOOOOOOOOO', 'monday' => false],
    'r223' => ['days' => 'FFOOFFFOOFFOOO', 'monday' => false],
    'we2' => ['days' => 'OOOOOFFOOOOOOO', 'monday' => true],
    'none' => ['days' => 'O', 'monday' => false],
];
const AP_JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const AP_MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

function ap_isIso($s): bool { return is_string($s) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $s) === 1; }
function ap_ts(string $d): int { [$y, $m, $j] = array_map('intval', explode('-', $d)); return gmmktime(0, 0, 0, $m, $j, $y); }
function ap_iso(int $t): string { return gmdate('Y-m-d', $t); }
function ap_add(string $d, int $n): string { return ap_iso(ap_ts($d) + $n * 86400); }
function ap_diff(string $a, string $b): int { return (int)round((ap_ts($b) - ap_ts($a)) / 86400); }
function ap_dow(string $d): int { return ((int)gmdate('w', ap_ts($d)) + 6) % 7; } // 0 = lundi
function ap_monday(string $d): string { return ap_add($d, -ap_dow($d)); }
function ap_other(string $w): string { return $w === 'a' ? 'b' : 'a'; }

/* Planning brut (data.json / base) -> réglages utiles, valeurs par défaut comme planning.js. */
function ap_norm($raw): array
{
    $r = is_array($raw) ? $raw : [];
    $p = $r['parents'] ?? [];
    $rh = $r['rhythm'] ?? [];
    return [
        'names' => ['a' => trim((string)($p['a']['name'] ?? '')) ?: 'Papa', 'b' => trim((string)($p['b']['name'] ?? '')) ?: 'Maman'],
        'preset' => isset(AP_PRESETS[$rh['preset'] ?? '']) ? $rh['preset'] : 'alt1',
        'first' => in_array($rh['first'] ?? '', ['a', 'b'], true) ? $rh['first'] : 'a',
        'ref' => ap_isIso($rh['ref'] ?? null) ? $rh['ref'] : '2026-11-16',
        'overrides' => is_array($r['overrides'] ?? null) ? $r['overrides'] : [],
        'events' => is_array($r['events'] ?? null) ? $r['events'] : [],
    ];
}

function ap_who(array $p, string $d): string
{
    $o = $p['overrides'][$d] ?? null;
    if (is_array($o) && in_array($o['w'] ?? '', ['a', 'b'], true)) return $o['w'];
    $pr = AP_PRESETS[$p['preset']];
    $start = $pr['monday'] ? ap_monday($p['ref']) : $p['ref'];
    $n = strlen($pr['days']);
    $i = ((ap_diff($start, $d) % $n) + $n) % $n;
    return $pr['days'][$i] === 'F' ? $p['first'] : ap_other($p['first']);
}
function ap_note(array $p, string $d): string
{
    return trim((string)($p['overrides'][$d]['n'] ?? ''));
}

/* Événements du jour : [['kind','title','age'?,'who'?,'multi'?]] */
function ap_events(array $p, string $d): array
{
    $out = [];
    $y = (int)substr($d, 0, 4);
    $leap = ($y % 4 === 0 && $y % 100 !== 0) || $y % 400 === 0;
    foreach ($p['events'] as $e) {
        if (!is_array($e) || !ap_isIso($e['date'] ?? null) || trim((string)($e['title'] ?? '')) === '') continue;
        $kind = $e['kind'] ?? 'event';
        if ($kind === 'anniv') {
            $md = substr($e['date'], 5);
            if ($md === '02-29' && !$leap) $md = '02-28';
            $year = isset($e['year']) ? (int)$e['year'] : 0;
            if ("$y-$md" === $d && (!$year || $y >= $year)) $out[] = ['kind' => 'anniv', 'title' => $e['title'], 'age' => $year ? $y - $year : null, 'who' => $e['who'] ?? null];
        } else {
            $end = ap_isIso($e['end'] ?? null) ? $e['end'] : $e['date'];
            if ($e['date'] <= $d && $d <= $end) $out[] = ['kind' => $kind, 'title' => $e['title'], 'who' => $e['who'] ?? null, 'start' => $e['date'] === $d];
        }
    }
    return $out;
}

function ap_longDate(string $d, bool $year = false): string
{
    $t = ap_ts($d);
    $j = (int)gmdate('j', $t);
    return AP_JOURS[ap_dow($d)] . ' ' . ($j === 1 ? '1er' : $j) . ' ' . AP_MOIS[(int)gmdate('n', $t) - 1] . ($year ? ' ' . gmdate('Y', $t) : '');
}
function ap_eventLabel(array $e): string
{
    $icon = ['anniv' => '🎂', 'trail' => '🏃', 'event' => '⭐'][$e['kind']] ?? '⭐';
    if ($e['kind'] === 'anniv') return "$icon Anniversaire de {$e['title']}" . ($e['age'] !== null ? " ({$e['age']} an" . ($e['age'] > 1 ? 's' : '') . ')' : '');
    return "$icon {$e['title']}";
}
