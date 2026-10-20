// Dot chat for direct-model mode (no Intelligence). Same layout, classes and
// transcript as Chat.tsx (ChatTranscript, Mascot, chat-composer); only the
// transport differs: the WO-07 conversation routes instead of CopilotKit.
// Voice, computer, pages and attachments need Intelligence, so they are not
// offered here; a short note says so.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { ArrowUp, Clock3, Square } from 'lucide-react';
import { ChatTranscript } from './ChatTranscript';
import { Mascot } from './Mascot';
import { DirectChatSession } from './direct-chat';
import type { Conversation, Dot } from '../shared/types';

export function DirectChat({
  thread,
  dot,
  model,
  initialPrompt,
  onConsumed,
  paused,
  onSaved,
  onSchedule,
  session: provided,
}: {
  thread: Conversation;
  dot: Dot;
  /** Model label for this Dot (its own choice or the server default). */
  model: string;
  initialPrompt?: string;
  onConsumed: () => void;
  paused: boolean;
  onSaved: () => void;
  onSchedule: () => void;
  /** Injected in tests; otherwise one session per thread. */
  session?: DirectChatSession;
}) {
  const session = useMemo(
    () => provided ?? new DirectChatSession(thread.id),
    [provided, thread.id],
  );
  const { messages, loaded, running, error } = useSyncExternalStore(
    session.subscribe,
    session.get,
    session.get,
  );
  const [draft, setDraft] = useState('');
  const sent = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!session.get().loaded) void session.load();
  }, [session]);
  const send = async (text: string) => {
    if (!text.trim() || running || !loaded || paused) return;
    setDraft('');
    if (await session.send(text)) onSaved();
    else setDraft((current) => current || text);
  };
  useEffect(() => {
    if (loaded && !paused && initialPrompt && !sent.current) {
      sent.current = true;
      onConsumed();
      void send(initialPrompt);
    }
  }, [loaded, paused, initialPrompt]);
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ behavior: 'instant', block: 'end' });
  }, [messages, running]);
  const streaming = messages.at(-1)?.id.startsWith('pending-') ?? false;
  return (
    <div className="live-chat direct-chat">
      <header className="chat-persona">
        <Mascot
          identity={dot.id}
          character={dot.avatar}
          hue={dot.hue}
          name={dot.name}
          small
          state={running ? 'working' : paused ? 'paused' : 'idle'}
        />
        <div>
          <strong>{dot.name}</strong>
          <span>
            {paused
              ? 'Paused'
              : running
                ? 'Thinking…'
                : loaded
                  ? 'Here with you'
                  : 'Loading your conversation…'}
            {' · '}
            <span className="dot-model" title="Model this Dot uses">
              {model}
            </span>
          </span>
        </div>
        <div className="chat-persona-actions">
          <button
            className="icon-button"
            aria-label="Schedule a task in this conversation"
            onClick={onSchedule}
          >
            <Clock3 size={18} />
          </button>
        </div>
      </header>
      <div className="chat-transcript">
        {loaded && !messages.length && (
          <div className="chat-welcome">
            <span className="eyebrow">A LITTLE SPACE TO THINK</span>
            <h1>What’s on your mind?</h1>
            <p>{dot.instructions}</p>
            <p className="muted">Your conversation stays with this Dot.</p>
          </div>
        )}
        <ChatTranscript messages={messages} calls={[]} />
        {running && !streaming && (
          <div className="thinking">
            <span />
            <span />
            <span />
            <span>{dot.name} is thinking</span>
          </div>
        )}
        <div ref={bottom} />
      </div>
      {error && (
        <div className="chat-error" role="alert">
          {error}
          {!loaded && (
            <button onClick={() => void session.load()}>Retry</button>
          )}
        </div>
      )}
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <div className="chat-compose-row">
          <textarea
            aria-label="Message your Dot"
            placeholder={`Message ${dot.name}…`}
            rows={1}
            value={draft}
            maxLength={4000}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {running ? (
            <button
              type="button"
              className="send-button"
              aria-label="Stop response"
              onClick={() => session.stop()}
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              className="send-button"
              aria-label="Send message"
              disabled={!draft.trim() || !loaded || paused}
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
