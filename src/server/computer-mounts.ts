export interface ComputerMount {
  host: string;
  path: string;
  mode: 'ro' | 'rw';
  /** Mounted for this Dot only (a dedicated project), not shared by every Dot. */
  scoped: boolean;
}

// Mirrors the supervisor's COMPUTER_EXTRA_BINDS grammar (see
// deployment/computers/add-extra-binds.mjs): "|"-separated [dotId=]host:container[:ro|rw].
// Returns the mounts that apply to one Dot, with container paths made relative to /workspace.
export function mountsFor(raw: string | undefined, dotId: string) {
  const mounts: ComputerMount[] = [];
  for (const item of (raw ?? '').split('|').filter(Boolean)) {
    const scoped = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})=(.+)$/.exec(item);
    if (scoped && scoped[1] !== dotId) continue;
    const parts = (scoped ? scoped[2] : item).split(':');
    // A Windows drive letter ("C:\x") splits at its colon; rejoin it onto the host path.
    if (/^[A-Za-z]$/.test(parts[0]) && parts.length > 2) {
      parts.splice(0, 2, `${parts[0]}:${parts[1]}`);
    }
    const [host, dest, mode] = parts;
    if (!host || !dest?.startsWith('/workspace/')) continue;
    // Masks (/dev/null files, empty dirs) hide secrets inside a mounted folder;
    // they are not folders to work in and would flood the prompt.
    if (host === '/dev/null' || host.endsWith('/.opendots-empty')) continue;
    mounts.push({
      host,
      path: dest.slice('/workspace/'.length),
      mode: mode === 'ro' ? 'ro' : 'rw',
      scoped: !!scoped,
    });
  }
  return mounts;
}

export function mountsPrompt(mounts: ComputerMount[]) {
  if (!mounts.length) return '';
  const list = mounts
    .map(
      (m) =>
        `"${m.path}" is the host folder ${m.host} (${m.mode === 'ro' ? 'read-only' : 'read/write'})`,
    )
    .join('; ');
  return ` Host folders are mounted in your computer's workspace: ${list}. Computer file tools take paths relative to the workspace root (for example "${mounts[0].path}/README.md"); never pass host paths such as C:\\... or absolute /paths. When a folder holds several projects, list it first to discover them, then inspect each project's README, package.json and source before answering, and work across folders when a task spans more than one project.`;
}
