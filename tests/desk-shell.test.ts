// Shell, write and memory desk tools: denylist, write confinement, remember/recall across threads.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { DirectModel, DirectThreadStore } from '../src/server/direct-model/index.js';
import { parseToolCalls, runTool, runToolRound, stripToolCalls } from '../src/server/direct-model/tools.js';
import { denyReason } from '../src/server/direct-model/shell-guard.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function tmp(prefix: string) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('shell denylist', () => {
  const denied = [
    'rm -rf /', 'RM  -RF   /', 'rm -fr /*', 'rm -r -f /', 'rm --recursive --force /', 'sudo rm -rf /root', 'rm -rf ~', 'rm -rf ~/',
    'rm -rf $HOME', 'rm -rf /etc', 'rm -rf /var/', 'rm -rf /home', 'rm -rf /mnt/genius_vol_2', 'rm -rf /data', 'rm -rf / --no-preserve-root',
    'ls && rm -rf /', 'echo hi; rm -rf /etc', 'cat x | xargs rm -rf /', "bash -c 'rm -rf /'", 'sh -c "echo a; rm -rf /root"', "bash -c \"sh -c 'rm -rf /'\"", '"rm" -rf "/"',
    'docker system prune -af', 'docker image prune', 'docker container prune -f', 'docker volume prune', 'docker volume rm opendots-data',
    'docker compose down -v', 'docker-compose down --volumes', 'docker compose -p x down -v',
    'mkfs.ext4 /dev/sda1', 'mkfs /dev/sdb', 'dd if=/dev/zero of=/dev/sda bs=1M', 'echo x > /dev/sda', 'cat y >/dev/nvme0n1',
    'psql -c "DROP DATABASE prod"', 'drop schema public cascade', 'psql -c "TRUNCATE TABLE users"', 'truncate orders',
    'shutdown -h now', 'sudo reboot', 'halt', 'poweroff', 'systemctl poweroff', 'ls; shutdown now',
    ':(){ :|:& };:', 'bomb(){ bomb|bomb& };bomb', 'chmod -R 777 /', 'chmod 777 -R /etc', 'cat /data/mtls/ca.key', 'ls /DATA/MTLS',
    'iptables -F', 'iptables -t nat -F', 'ufw disable', 'sudo ufw   disable',
  ];
  for (const command of denied) it(`denies: ${command}`, () => expect(denyReason(command), command).toBeTruthy());

  const allowed = [
    'uname -a && whoami', 'ls -la', 'rm -rf node_modules', 'rm -rf ./build /tmp/x', 'rm file.txt', 'env | grep -i key', 'echo "reboot later"',
    'git log --oneline | grep reboot', 'dd if=/dev/zero of=./file bs=1k count=1', 'echo hi > /dev/null', 'docker ps', 'docker compose up -d',
    'psql -c "TRUNCATE TABLE temp_scratch"', 'truncate -s 0 out.log', 'chmod -R 755 ./dist', 'cat notes.md', 'rm -rf /tmp/build-123',
  ];
  for (const command of allowed) it(`allows: ${command}`, () => expect(denyReason(command), command).toBeNull());
});

describe('tag parsing', () => {
  it('parses shell lines containing ] and multi-line write blocks in order', () => {
    const text = 'Ok.\n[[shell: [ -f a ] && echo yes]]\n[[write: notes/a.md]]\nline [[read: x]] one\n[[/write]]\n[[remember: owner likes tea]]\n[[recall: tea]]';
    expect(parseToolCalls(text)).toEqual([
      { name: 'shell', arg: '[ -f a ] && echo yes' },
      { name: 'write', arg: 'notes/a.md', body: 'line [[read: x]] one\n' },
      { name: 'remember', arg: 'owner likes tea' },
      { name: 'recall', arg: 'tea' },
    ]);
    expect(stripToolCalls(text)).toBe('Ok.');
  });
});

describe('shell tool', () => {
  it('denies before running, logs, and passes allowed commands to the runner', async () => {
    const ran: string[] = [];
    const logs: string[] = [];
    const options = { shell: async (c: string) => { ran.push(c); return 'ok'; }, log: (l: string) => logs.push(l) };
    expect(await runTool({ name: 'shell', arg: 'rm -rf /' }, options)).toMatch(/^DENIED: recursive rm of \//);
    expect(await runTool({ name: 'shell', arg: 'docker system prune -af' }, options)).toMatch(/^DENIED: docker prune/);
    expect(await runTool({ name: 'shell', arg: 'uname -a' }, options)).toBe('ok');
    expect(ran).toEqual(['uname -a']);
    expect(logs.filter((l) => l.includes('DENIED'))).toHaveLength(2);
    expect(await runTool({ name: 'shell', arg: 'ls' }, {})).toContain('not enabled');
  });
  it('runs mutating tools in order within a round', async () => {
    const order: string[] = [];
    const block = await runToolRound(
      [{ name: 'shell', arg: 'a' }, { name: 'shell', arg: 'b' }],
      { shell: async (c) => { await new Promise((r) => setTimeout(r, c === 'a' ? 20 : 1)); order.push(c); return c; } },
    );
    expect(order).toEqual(['a', 'b']);
    expect(block).toContain('### shell: a');
  });
});

describe('write tool', () => {
  it('writes under the work root, reads back via work/, and refuses escapes and big files', async () => {
    const workRoot = path.join(await tmp('work-'), 'devvy');
    expect(await runTool({ name: 'write', arg: 'notes/a.md', body: 'hello' }, { workRoot })).toContain('Wrote 5 bytes to notes/a.md');
    expect(await readFile(path.join(workRoot, 'notes', 'a.md'), 'utf8')).toBe('hello');
    expect(await runTool({ name: 'read', arg: 'work/notes/a.md' }, { workRoot })).toBe('hello');
    expect(await runTool({ name: 'ls', arg: 'work/notes' }, { workRoot })).toContain('file a.md');
    for (const bad of ['../x.txt', 'a/../../x.txt', '/etc/passwd', '..', '.', 'C:\\x.txt'])
      expect(await runTool({ name: 'write', arg: bad, body: 'x' }, { workRoot }), bad).toContain('Tool failed');
    expect(await runTool({ name: 'write', arg: 'big.bin', body: 'x'.repeat(2 * 1024 * 1024 + 1) }, { workRoot })).toContain('limit');
    expect(await runTool({ name: 'write', arg: 'ok.bin', body: 'x'.repeat(2 * 1024 * 1024) }, { workRoot })).toContain('Wrote');
    expect(await runTool({ name: 'write', arg: 'a', body: 'x' }, {})).toContain('not enabled');
  });
  it('refuses symlink escapes', async () => {
    const workRoot = await tmp('work-');
    const outside = await tmp('outside-');
    try {
      await symlink(outside, path.join(workRoot, 'link'), 'junction');
    } catch {
      return; // no symlink privilege on this machine
    }
    expect(await runTool({ name: 'write', arg: 'link/pwn.txt', body: 'x' }, { workRoot })).toContain('symlink');
    await writeFile(path.join(outside, 'f.txt'), 'x');
    await mkdir(path.join(workRoot, 'd'), { recursive: true });
    expect(await runTool({ name: 'write', arg: 'link', body: 'x' }, { workRoot })).toContain('Tool failed');
  });
});

describe('remember and recall', () => {
  it('stores a per-Dot memory and recalls it from a new thread and prompt', async () => {
    const replies = ['[[remember: The owner prefers metric units]]', 'Noted.', '[[recall: units]]', 'You prefer metric units.'];
    const prompts: string[] = [];
    const fake = (async (_url: unknown, init: RequestInit) => {
      const messages = JSON.parse(String(init.body)).messages;
      prompts.push(messages[0].content);
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: replies.shift() } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const threads = new DirectThreadStore(':memory:');
    cleanups.push(() => { store.close(); workspace.close(); threads.close(); });
    const direct = new DirectModel({ store, workspace, threads, fetch: fake, backoffMs: 0, budgetMs: 10_000, model: { apiKey: 'k', baseUrl: 'http://stub/v1', model: 'm' } });
    const [dot] = workspace.dots();
    const other = workspace.createDot(workspace.spaces()[0].id, 'Other', '', true, true);
    const one = direct.createConversation(dot.id, 'one');
    expect((await direct.turn(one.id, 'Remember I like metric units')).text).toBe('Noted.');
    const memory = store.memories().find((m) => m.text.includes('metric'))!;
    expect(workspace.memoryScopes.scopeOf(memory.id)).toBe(dot.id);
    const two = direct.createConversation(dot.id, 'two');
    expect((await direct.turn(two.id, 'What units do I like?')).text).toBe('You prefer metric units.');
    expect(prompts[2]).toContain('metric units');
    expect(prompts[0]).toContain('[[remember:');
    expect(workspace.memoryScopes.visible(store.memories(), other.id).some((m) => m.id === memory.id)).toBe(false);
  });
});
