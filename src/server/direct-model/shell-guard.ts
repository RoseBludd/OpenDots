// Denylist for the [[shell]] desk tool. Checked before any command runs, on the whole
// command and on every segment (split on ; && || | & newlines, $( ) and backticks) and,
// recursively, on quoted strings so `bash -c "rm -rf /"` is caught as well.
// It is a guard against model mistakes, not a sandbox: the sandbox/computer is the boundary.

const PROTECTED_DIRS = [
  '/', '/root', '/mnt', '/data', '/etc', '/var', '/home', '/usr', '/bin', '/sbin', '/lib', '/lib64',
  '/boot', '/opt', '/srv', '/sys', '/proc', '/dev', '~', '$home', '${home}',
];
const PREFIX_DENIED = ['/mnt', '/data'];
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'nohup', 'command', 'exec', 'time', 'nice', 'ionice', 'xargs', 'timeout', 'busybox', 'setsid', 'stdbuf']);
const POWER = new Set(['shutdown', 'reboot', 'halt', 'poweroff']);

export function normalizeCommand(command: string): string {
  return command.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/[ \t\r]+/g, ' ').trim().toLowerCase();
}

function protectedTarget(raw: string): boolean {
  let target = raw.replace(/^['"]|['"]$/g, '');
  if (/^(\/+\.\.?\/?)+$/.test(target)) return true;
  target = target.replace(/\/+/g, '/');
  const bare = target.replace(/\/\*?$/, '') || '/';
  if (target === '/' || target === '/*' || target === '/.' || target === '/..') return true;
  if (PROTECTED_DIRS.includes(bare) && bare !== '/') return true;
  return PREFIX_DENIED.some((dir) => bare === dir || bare.startsWith(`${dir}/`));
}

function splitSegments(text: string): string[] {
  return text
    .split(/&&|\|\||[;|&\n`]|\$\(|\)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function quoted(text: string): string[] {
  return [...text.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2] ?? '').filter(Boolean);
}

function tokens(segment: string): string[] {
  return segment.split(' ').map((t) => t.replace(/^['"]+|['"]+$/g, '')).filter(Boolean);
}

/** The first token that is not a wrapper such as sudo or env VAR=1. */
function commandWord(list: string[]): string | undefined {
  return list.find((t) => !WRAPPERS.has(t) && !t.startsWith('-') && !/^[a-z_][a-z0-9_]*=/.test(t));
}

function checkSegment(segment: string): string | null {
  const list = tokens(segment);
  const base = (t: string) => t.slice(t.lastIndexOf('/') + 1);
  const head = commandWord(list);
  const headBase = head ? base(head) : '';

  const rmAt = list.findIndex((t) => base(t) === 'rm');
  if (rmAt >= 0) {
    const args = list.slice(rmAt + 1);
    const flags = args.filter((a) => a.startsWith('-'));
    const recursive = flags.some((f) => f === '--recursive' || (!f.startsWith('--') && /r/.test(f)));
    if (flags.includes('--no-preserve-root')) return 'rm --no-preserve-root';
    if (recursive) {
      const hit = args.find((a) => !a.startsWith('-') && protectedTarget(a));
      if (hit) return `recursive rm of ${hit}`;
    }
  }
  if (POWER.has(headBase)) return `${headBase}`;
  if (headBase === 'systemctl' && list.some((t) => ['reboot', 'poweroff', 'halt', 'kexec'].includes(t))) return 'systemctl power-off';
  if ((headBase === 'init' || headBase === 'telinit') && list.some((t) => t === '0' || t === '6')) return 'init 0/6';
  if (headBase.startsWith('mkfs')) return 'mkfs';
  if (headBase === 'wipefs' || (headBase === 'shred' && list.some((t) => t.startsWith('/dev/')))) return 'disk wipe';
  if (headBase === 'dd' && list.some((t) => /^of=\/dev\//.test(t))) return 'dd to a device';
  if (headBase === 'chmod' && list.some((t) => /^-[a-z]*r/.test(t) || t === '--recursive') && list.includes('777') && list.some((t) => !t.startsWith('-') && t !== '777' && t !== 'chmod' && protectedTarget(t)))
    return 'chmod -R 777 on a system path';
  if ((headBase === 'iptables' || headBase === 'ip6tables') && list.some((t) => t === '-f' || t === '--flush')) return 'iptables -F';
  if (headBase === 'nft' && list.includes('flush')) return 'nft flush';
  if (headBase === 'ufw' && list.includes('disable')) return 'ufw disable';
  if (headBase === 'docker' || headBase === 'docker-compose') {
    if (list.includes('prune')) return 'docker prune';
    if (list.includes('volume') && list.includes('rm')) return 'docker volume rm';
    if (list.includes('down') && list.some((t) => t === '-v' || t === '--volumes' || (/^-[a-z]*v[a-z]*$/.test(t) && !t.startsWith('--'))))
      return 'docker compose down -v';
  }
  return null;
}

const WHOLE_RULES: [RegExp, string][] = [
  [/\/data\/mtls/, '/data/mtls'],
  [/\bdrop\s+(database|schema)\b/, 'DROP DATABASE/SCHEMA'],
  [/\btruncate\s+(?:table\s+)?(?:only\s+)?(?!temp|tmp|table\b|only\b|-)[a-z_"`[]/, 'TRUNCATE on a non-temp table'],
  [/>\s*\/dev\/(sd|hd|vd|xvd|nvme|mmcblk)/, 'redirect to a block device'],
  [/\bdd\b[^;|&\n]*\bof=\/dev\/(?!null|zero|stdout|stderr|tty)/, 'dd to a device'],
  [/\bdocker(-compose)?\b[^;|&\n]*\bprune\b/, 'docker prune'],
  [/\bdocker\s+volume\s+rm\b/, 'docker volume rm'],
  [/\biptables\s+(-\w+\s+)*(-f|--flush)\b/, 'iptables -F'],
  [/\bufw\s+disable\b/, 'ufw disable'],
];

/** Fork bomb shapes: `:(){ :|:& };:` and `f(){ f|f& };f`, whitespace-insensitive. */
function forkBomb(text: string): boolean {
  const squeezed = text.replace(/\s+/g, '');
  return /([a-z_:][\w:]*)\(\)\{\1\|\1&?\}/.test(squeezed);
}

function scan(text: string, depth: number): string | null {
  const normalized = normalizeCommand(text);
  for (const [re, name] of WHOLE_RULES) if (re.test(normalized)) return name;
  if (forkBomb(normalized)) return 'fork bomb';
  for (const segment of splitSegments(normalized)) {
    const hit = checkSegment(segment);
    if (hit) return hit;
  }
  // Text only echoed is not executed, unless something in the command feeds it to a shell.
  const inertEcho = /^(echo|printf)\b/.test(normalized) && !/\b(sh|bash|zsh|dash|ksh|eval|source|xargs)\b/.test(normalized);
  if (depth < 4 && !inertEcho) {
    for (const inner of quoted(normalized)) {
      const hit = scan(inner, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Returns the name of the rule that denies this command, or null when it may run. */
export function denyReason(command: string): string | null {
  return scan(command, 0);
}
