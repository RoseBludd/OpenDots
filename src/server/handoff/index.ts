// Dot-to-Dot handoff and the Dot registry (WO-TWIN-B).
//
// Ported from RoseBludd/agentconnect (registry + delegation patterns), adapted
// to OpenDots' own DB/task APIs. All state lives in the local WorkspaceStore and
// Store; nothing is written to R2 or external storage. The runner/scheduler are
// untouched — handoff only enqueues a background task in the target Dot's thread.

import { randomUUID } from 'node:crypto';
import type { Store } from '../store.js';
import type { WorkspaceStore } from '../workspace.js';
import type { Dot } from '../../shared/types.js';

/** A handoff request recorded in the target Dot's thread. */
export interface HandoffRequest {
  id: string;
  fromDot: string;
  toDot: string;
  thread: string;
  note: string;
  createdAt: number;
}

/** Capability summary for one Dot, as returned by the registry. */
export interface DotCapability {
  id: string;
  name: string;
  instructions: string;
  summary: string;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  skillDeliveryEnabled: boolean;
  computerEnabled: boolean;
  spaces: { id: string; name: string }[];
  model: string | null;
  desk: string | null;
}

export class HandoffService {
  constructor(
    private store: Store,
    private workspace: WorkspaceStore,
  ) {}

  /** List every Dot with the capabilities the owner cares about. */
  registry(): DotCapability[] {
    const spaces = new Map(
      this.workspace.spaces().map((space) => [space.id, space] as const),
    );
    return this.workspace.dots().map((dot) => ({
      id: dot.id,
      name: dot.name,
      instructions: dot.instructions,
      summary: summarize(dot),
      researchAllowed: dot.researchAllowed,
      memoryAllowed: dot.memoryAllowed,
      skillDeliveryEnabled: !!dot.skillDeliveryEnabled,
      computerEnabled: this.workspace.computers.permissions(dot.id).enabled,
      spaces: dot.spaceIds
        .map((id) => {
          const space = spaces.get(id);
          return space ? { id, name: space.name } : null;
        })
        .filter(
          (entry): entry is { id: string; name: string } => entry !== null,
        ),
      model: dot.model ?? null,
      desk: dot.desk ?? null,
    }));
  }

  /**
   * Hand off work to another Dot. Creates a thread in the target Dot's
   * conversation list when one does not already exist, then enqueues a task
   * in that thread through the normal task queue/store APIs. The source Dot
   * and a note are recorded on the task prompt so the target Dot can see who
   * asked and why.
   */
  handoffTo(
    dot: string,
    thread: string,
    note: string,
    fromDot: string,
  ): { handoff: HandoffRequest; task: { id: string; threadId: string } } {
    const target = this.workspace.dot(dot);
    if (!target) throw new Error('Target Dot not found.');
    const trimmedNote = note.trim();
    if (!trimmedNote) throw new Error('A handoff note is required.');
    if (trimmedNote.length > 2000)
      throw new Error('Handoff note must be 2,000 characters or fewer.');

    const sourceDot = this.workspace.dot(fromDot);
    const conversation = this.workspace.conversations().find((c) => c.id === thread);
    let threadId = thread;
    if (!conversation) {
      // Bind a fresh thread to the target Dot so the task has a home.
      const created = this.workspace.bindThread(
        randomUUID(),
        target.id,
        `Handoff from ${sourceDot?.name ?? fromDot}`,
      );
      threadId = created.id;
    } else if (conversation.dotId !== target.id) {
      throw new Error(
        'That conversation belongs to a different Dot; handoff needs its own thread.',
      );
    }

    const source = this.workspace.dot(fromDot);
    const prompt = `Handoff from ${source?.name ?? fromDot} (${fromDot}) to ${target.name}.\n\n${trimmedNote}`;
    const task = this.store.createTask(prompt);
    this.workspace.bindTask(task.id, threadId);
    return {
      handoff: {
        id: task.id,
        fromDot,
        toDot: target.id,
        thread: threadId,
        note: trimmedNote,
        createdAt: task.createdAt,
      },
      task: { id: task.id, threadId },
    };
  }
}

/** Produce a short instructions summary for the registry listing. */
function summarize(dot: Dot): string {
  const text = dot.instructions.trim();
  if (!text) return '';
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}