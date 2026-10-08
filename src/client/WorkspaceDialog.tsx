import { useEffect, useRef, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { Mascot, characters } from './Mascot';
import type {
  Dot,
  FamilyUser,
  JoinCodeRecord,
  Memory,
  State,
  WorkspaceState,
} from '../shared/types';
import { api } from './api';
export type Dialog =
  | { type: 'space' }
  | { type: 'dot'; dot?: Dot; spaceId: string }
  | { type: 'settings' }
  | { type: 'memory'; memory?: Memory }
  | { type: 'schedule'; threadId: string };
export function WorkspaceDialog({
  dialog,
  state,
  workspace,
  onClose,
  mutate,
  familyUser,
  onFamilyUserChange,
}: {
  dialog: Dialog;
  state: State;
  workspace: WorkspaceState;
  onClose: () => void;
  mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
  familyUser?: FamilyUser | null;
  onFamilyUserChange?: () => void;
}) {
  const [name, setName] = useState(
    dialog.type === 'dot' ? (dialog.dot?.name ?? '') : '',
  );
  const [text, setText] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.instructions ?? '')
      : dialog.type === 'memory'
        ? (dialog.memory?.text ?? '')
        : '',
  );
  const [research, setResearch] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.researchAllowed ?? true)
      : state.settings.researchAllowed,
  );
  const [memory, setMemory] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.memoryAllowed ?? true)
      : state.settings.memoryAllowed,
  );
  const [spaceIds, setSpaceIds] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceIds ?? [dialog.spaceId]) : [],
  );
  const [defaultSpace, setDefaultSpace] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceId ?? dialog.spaceId) : '',
  );
  const [interval, setInterval] = useState('86400');
  const [learningContainer, setLearningContainer] = useState(
    dialog.type === 'dot' ? (dialog.dot?.learningContainerId ?? '') : '',
  );
  const [skillDelivery, setSkillDelivery] = useState(
    dialog.type === 'dot' ? (dialog.dot?.skillDeliveryEnabled ?? false) : false,
  );
  const [avatar, setAvatar] = useState<string | null>(
    dialog.type === 'dot' ? (dialog.dot?.avatar ?? null) : null,
  );
  const [projectPath, setProjectPath] = useState(
    dialog.type === 'dot' ? (dialog.dot?.projectPath ?? '') : '',
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isGuardian = familyUser?.role === 'guardian';
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const [members, setMembers] = useState<FamilyUser[]>([]);
  const [codes, setCodes] = useState<JoinCodeRecord[]>([]);
  const [familyError, setFamilyError] = useState('');
  const [newCodeRole, setNewCodeRole] = useState<'adult' | 'kid'>('adult');
  const [generatedCode, setGeneratedCode] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const loadFamily = () => {
    void api<{ users: FamilyUser[] }>('/auth/members')
      .then((r) => setMembers(r.users))
      .catch((e) => setFamilyError(e instanceof Error ? e.message : ''));
    void api<{ codes: JoinCodeRecord[] }>('/auth/join-codes')
      .then((r) => setCodes(r.codes))
      .catch((e) => setFamilyError(e instanceof Error ? e.message : ''));
  };
  useEffect(() => {
    if (dialog.type === 'settings' && isGuardian) loadFamily();
  }, [dialog.type, isGuardian]);
  const uploadAvatar = (file: File) => {
    setAvatarError('');
    setAvatarBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      void api('/auth/avatar', 'POST', { dataUrl: reader.result })
        .then(() => onFamilyUserChange?.())
        .catch((e) =>
          setAvatarError(e instanceof Error ? e.message : 'Could not upload.'),
        )
        .finally(() => setAvatarBusy(false));
    };
    reader.onerror = () => {
      setAvatarError('Could not read that file.');
      setAvatarBusy(false);
    };
    reader.readAsDataURL(file);
  };
  const generateCode = () => {
    setCodeBusy(true);
    setFamilyError('');
    void api<{ code: string }>('/auth/join-codes', 'POST', {
      role: newCodeRole,
    })
      .then((r) => {
        setGeneratedCode(r.code);
        loadFamily();
      })
      .catch((e) =>
        setFamilyError(e instanceof Error ? e.message : 'Could not generate.'),
      )
      .finally(() => setCodeBusy(false));
  };
  const revokeCode = (id: string) => {
    setFamilyError('');
    void api(`/auth/join-codes/${id}`, 'DELETE')
      .then(() => loadFamily())
      .catch((e) =>
        setFamilyError(e instanceof Error ? e.message : 'Could not revoke.'),
      );
  };
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    container.current
      ?.querySelector<HTMLElement>('input,textarea,select')
      ?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const items = [
          ...(container.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input,textarea,select,a[href]',
          ) ?? []),
        ];
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  const title =
    dialog.type === 'space'
      ? 'A space for something.'
      : dialog.type === 'dot'
        ? dialog.dot
          ? 'Make this Dot yours.'
          : 'Meet your next specialist.'
        : dialog.type === 'settings'
          ? 'Your workspace, your rules.'
          : dialog.type === 'memory'
            ? 'Something to remember.'
            : 'Let your Dot keep time.';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={container}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="eyebrow">OPENDOTS TEMPLATE</span>
        <h2 id="dialog-title">{title}</h2>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            let path = '',
              method = 'POST',
              body: unknown;
            if (dialog.type === 'space') {
              path = '/spaces';
              body = { name, description: text };
            }
            if (dialog.type === 'dot') {
              path = dialog.dot ? `/dots/${dialog.dot.id}` : '/dots';
              method = dialog.dot ? 'PUT' : 'POST';
              body = {
                spaceId: defaultSpace,
                spaceIds,
                name,
                instructions: text,
                researchAllowed: research,
                memoryAllowed: memory,
                learningContainerId: learningContainer.trim() || null,
                skillDeliveryEnabled: skillDelivery,
                avatar,
                projectPath: projectPath.trim() || null,
              };
            }
            if (dialog.type === 'settings') {
              path = '/settings';
              method = 'PATCH';
              body = { researchAllowed: research, memoryAllowed: memory };
            }
            if (dialog.type === 'memory') {
              path = dialog.memory
                ? `/memories/${dialog.memory.id}`
                : '/memories';
              method = dialog.memory ? 'PUT' : 'POST';
              body = { text };
            }
            if (dialog.type === 'schedule') {
              path = '/tasks';
              body = {
                prompt: text,
                threadId: dialog.threadId,
                intervalSeconds: Number(interval),
              };
            }
            if (await mutate(path, method, body)) onClose();
            else
              setError('Could not save. Review the workspace error and retry.');
            setBusy(false);
          }}
        >
          {(dialog.type === 'space' || dialog.type === 'dot') && (
            <>
              <label className="field-label" htmlFor="entity-name">
                Name
              </label>
              <input
                id="entity-name"
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </>
          )}
          {dialog.type === 'dot' && (
            <fieldset className="character-picker">
              <legend>Character</legend>
              <div className="character-options">
                {characters.map((character) => (
                  <button
                    type="button"
                    key={character}
                    className={`character-option ${avatar === character ? 'selected' : ''}`}
                    aria-pressed={avatar === character}
                    aria-label={`Choose the ${character} character`}
                    onClick={() => setAvatar(character)}
                  >
                    <Mascot character={character} small decorative />
                  </button>
                ))}
                <button
                  type="button"
                  className={`character-option auto ${avatar === null ? 'selected' : ''}`}
                  aria-pressed={avatar === null}
                  onClick={() => setAvatar(null)}
                >
                  Auto
                </button>
              </div>
            </fieldset>
          )}
          {dialog.type !== 'settings' && (
            <>
              <label className="field-label" htmlFor="entity-text">
                {dialog.type === 'dot'
                  ? 'Role instructions'
                  : dialog.type === 'space'
                    ? 'What belongs here?'
                    : dialog.type === 'memory'
                      ? 'Preference or context'
                      : 'Task to revisit'}
              </label>
              <textarea
                id="entity-text"
                rows={4}
                maxLength={dialog.type === 'schedule' ? 4000 : 2000}
                required={dialog.type !== 'space'}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  dialog.type === 'dot'
                    ? 'You are a thoughtful research partner. Compare evidence and be clear about uncertainty.'
                    : ''
                }
              />
            </>
          )}
          {dialog.type === 'dot' && (
            <fieldset className="space-access-fields">
              <legend>Project folder</legend>
              <label className="field-label" htmlFor="project-path">
                Limit this Dot&apos;s computer to one folder
              </label>
              <input
                id="project-path"
                value={projectPath}
                maxLength={300}
                placeholder="C:\Users\you\my-project (blank = whole workspace)"
                onChange={(event) => setProjectPath(event.target.value)}
              />
              <p className="muted">
                Its computer sees only this folder, at <code>project/</code>.
                Changing it stops the computer; start it again to apply.
              </p>
            </fieldset>
          )}
          {dialog.type === 'dot' && dialog.dot && (
            <p className="muted dot-id-row">
              Dot ID: <code>{dialog.dot.id}</code>{' '}
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  void navigator.clipboard?.writeText(dialog.dot!.id)
                }
              >
                Copy
              </button>
            </p>
          )}
          {dialog.type === 'dot' && (
            <fieldset className="space-access-fields">
              <legend>Space access</legend>
              <p className="muted">
                Choose where this Dot can read and edit pages.
              </p>
              {workspace.spaces.map((space) => (
                <label className="permission-row" key={space.id}>
                  <input
                    type="checkbox"
                    checked={spaceIds.includes(space.id)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...spaceIds, space.id]
                        : spaceIds.filter((id) => id !== space.id);
                      setSpaceIds(next);
                      if (!next.includes(defaultSpace))
                        setDefaultSpace(next[0] ?? '');
                    }}
                  />
                  <span>{space.name}</span>
                </label>
              ))}
              <label className="field-label" htmlFor="default-space">
                Default destination for saved pages
              </label>
              <select
                id="default-space"
                value={defaultSpace}
                required
                onChange={(event) => setDefaultSpace(event.target.value)}
              >
                <option value="" disabled>
                  Choose a Space
                </option>
                {workspace.spaces
                  .filter((space) => spaceIds.includes(space.id))
                  .map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.name}
                    </option>
                  ))}
              </select>
            </fieldset>
          )}
          {(dialog.type === 'dot' || dialog.type === 'settings') && (
            <>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={research}
                  onChange={(e) => setResearch(e.target.checked)}
                />
                <span>
                  <strong>Public-page research</strong>
                  <small>
                    Allow the server-side read-only browser tool. Global
                    settings always take precedence.
                  </small>
                </span>
              </label>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={memory}
                  onChange={(e) => setMemory(e.target.checked)}
                />
                <span>
                  <strong>Use saved memories</strong>
                  <small>
                    Include your preferences in new turns. Changing permission
                    stops active work.
                  </small>
                </span>
              </label>
            </>
          )}
          {dialog.type === 'dot' && (
            <fieldset className="space-access-fields">
              <legend>Automatic Learning</legend>
              <label className="field-label" htmlFor="learning-container">
                Learning container ID
              </label>
              <input
                id="learning-container"
                value={learningContainer}
                maxLength={64}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                placeholder="research-workflow"
                aria-describedby="learning-help"
                onChange={(event) => {
                  setLearningContainer(event.target.value);
                  if (!event.target.value.trim()) setSkillDelivery(false);
                }}
              />
              <p className="muted" id="learning-help">
                Create this container in your Intelligence project first. New
                conversations will contribute evidence to it. Leave blank to
                keep new conversations out of Learning. Existing conversations
                retain their original assignment.
              </p>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={skillDelivery}
                  disabled={!learningContainer.trim()}
                  onChange={(event) => setSkillDelivery(event.target.checked)}
                />
                <span>
                  <strong>Use published skills</strong>
                  <small>
                    Load reviewed skills from each conversation’s assigned
                    container. Enable delivery in Intelligence too. Turning this
                    off stops skill loading; it does not stop evidence
                    collection.
                  </small>
                </span>
              </label>
              <a
                href="https://docs.copilotkit.ai/learning"
                target="_blank"
                rel="noreferrer"
              >
                Set up Learning and review skills ↗
              </a>
            </fieldset>
          )}
          {dialog.type === 'schedule' && (
            <>
              <label className="field-label" htmlFor="schedule-interval">
                Repeat after each successful run
              </label>
              <select
                id="schedule-interval"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
              >
                <option value="60">Every minute (testing)</option>
                <option value="3600">Every hour</option>
                <option value="86400">Every day</option>
                <option value="604800">Every week</option>
              </select>
              <p className="muted">
                Runs on the server in this same conversation, even with the tab
                closed. Failed runs wait for manual retry.
              </p>
            </>
          )}
          {dialog.type === 'settings' && (
            <div className="config-note">
              <strong>Service setup</strong>
              <p>
                {workspace.setup.missing.length
                  ? `Add ${workspace.setup.missing.join(', ')} to the server environment, then restart.`
                  : 'Text configuration is present. A successful conversation confirms connectivity.'}
              </p>
              <p>
                Slack: {workspace.setup.slack.replaceAll('_', ' ')}. Voice:{' '}
                {workspace.setup.voice
                  ? 'configuration present'
                  : 'needs VOICE_API_KEY and VOICE_MODEL'}
                .
              </p>
              <a
                href="https://github.com/CopilotKit/OpenDots/blob/main/docs/SETUP.md"
                target="_blank"
                rel="noreferrer"
              >
                Template setup guide ↗
              </a>
            </div>
          )}
          {dialog.type === 'settings' && familyUser && (
            <div className="family-section">
              <h3>Your profile</h3>
              <div className="family-avatar-row">
                <span className="avatar-circle">
                  {familyUser.avatarPath ? (
                    <img
                      src={`/api/auth/avatar/${familyUser.id}?t=${familyUser.avatarUpdatedAt ?? 0}`}
                      alt=""
                    />
                  ) : (
                    <span>{familyUser.name.charAt(0).toUpperCase()}</span>
                  )}
                </span>
                <label className="field-label" htmlFor="avatar-upload">
                  {avatarBusy ? 'Uploading…' : 'Change photo'}
                  <input
                    id="avatar-upload"
                    type="file"
                    accept="image/png,image/jpeg"
                    disabled={avatarBusy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) uploadAvatar(file);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
              {avatarError && (
                <p className="chat-error" role="alert">
                  {avatarError}
                </p>
              )}
            </div>
          )}
          {dialog.type === 'settings' && isGuardian && (
            <div className="family-section">
              <h3>Family members</h3>
              {members.map((member) => (
                <div className="member-row" key={member.id}>
                  <span className="avatar-circle">
                    {member.avatarPath ? (
                      <img
                        src={`/api/auth/avatar/${member.id}?t=${member.avatarUpdatedAt ?? 0}`}
                        alt=""
                      />
                    ) : (
                      <span>{member.name.charAt(0).toUpperCase()}</span>
                    )}
                  </span>
                  <span className="member-info">
                    <strong>{member.name}</strong>
                    {member.email && <small>{member.email}</small>}
                  </span>
                  <span className="role-badge">{member.role}</span>
                </div>
              ))}
              <h3>Join codes</h3>
              <div className="join-code-generator">
                <select
                  value={newCodeRole}
                  onChange={(e) =>
                    setNewCodeRole(e.target.value as 'adult' | 'kid')
                  }
                >
                  <option value="adult">Adult</option>
                  <option value="kid">Kid</option>
                </select>
                <button
                  type="button"
                  className="primary"
                  disabled={codeBusy}
                  onClick={generateCode}
                >
                  {codeBusy ? 'Generating…' : 'Generate join code'}
                </button>
              </div>
              {generatedCode && (
                <p className="join-code-display">
                  Share this code: <code>{generatedCode}</code>
                </p>
              )}
              {codes.map((code) => {
                const status = code.revokedAt
                  ? 'Revoked'
                  : code.usedByUserId
                    ? 'Used'
                    : code.expiresAt < Date.now()
                      ? 'Expired'
                      : 'Active';
                return (
                  <div className="join-code-item" key={code.id}>
                    <span>{code.role}</span>
                    <span className={status === 'Active' ? '' : 'status-used'}>
                      {status}
                    </span>
                    {status === 'Active' && (
                      <button type="button" onClick={() => revokeCode(code.id)}>
                        Revoke
                      </button>
                    )}
                  </div>
                );
              })}
              {familyError && (
                <p className="chat-error" role="alert">
                  {familyError}
                </p>
              )}
            </div>
          )}
          {dialog.type === 'memory' && (
            <p className="muted">
              Memories are explicit preferences, not automatic learning. Avoid
              secrets; enabled memories go to your model provider.
            </p>
          )}
          {error && (
            <p className="chat-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary full" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </form>
        {dialog.type === 'dot' && dialog.dot && (
          <div className="danger-zone">
            {workspace.dots.length <= 1 ? (
              <p className="muted">Keep at least one Dot in your workspace.</p>
            ) : confirmDelete ? (
              <>
                <p role="alert">
                  Delete {dialog.dot.name} and its{' '}
                  {
                    workspace.conversations.filter(
                      (item) => item.dotId === dialog.dot!.id,
                    ).length
                  }{' '}
                  conversation(s)? This can’t be undone.
                </p>
                <div className="danger-actions">
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      if (await mutate(`/dots/${dialog.dot!.id}`, 'DELETE'))
                        onClose();
                      else setError('Could not delete this Dot.');
                      setBusy(false);
                    }}
                  >
                    {busy ? 'Deleting…' : 'Yes, delete'}
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                className="danger-link"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={14} /> Delete this Dot
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
