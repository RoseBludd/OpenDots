import { Hono } from 'hono';
import { z } from 'zod';
import type {
  FamilyStore,
  FamilyUser,
  Memory,
  Visibility,
  Share,
} from './family-store.js';
import type { AuthStore } from './auth-store.js';

const memoryInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(5_000).optional().default(''),
    visibility: z.enum(['private', 'family', 'public']),
    occurredAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .nullable(),
    peopleIds: z.array(z.string()).optional(),
  })
  .strict();

function isoToDate(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export function familyRoutes(
  familyStore: FamilyStore,
  auth?: AuthStore,
  origin?: string,
) {
  const app = new Hono();

  // Auth mirror: /api/family/* inherits the auth gate from app.ts (/api/* middleware).

  app.get('/people', (c) => {
    const user = auth?.userFromContext(c);
    return c.json(familyStore.listPeople());
  });

  app.post('/people', async (c) => {
    const actor = auth?.userFromContext(c);
    if (!actor || actor.role !== 'guardian')
      return c.json({ error: 'Only a guardian can add family members.' }, 403);
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(80),
        email: z.string().trim().email().max(254).optional(),
        isMinor: z.boolean().optional().default(false),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Provide a name; optionally an email and isMinor.' },
        400,
      );
    const person = familyStore.createPerson(
      parsed.data.name,
      actor.id,
      parsed.data.email ?? null,
      parsed.data.isMinor,
    );
    return c.json({ person }, 201);
  });

  app.delete('/people/:id', async (c) => {
    const actor = auth?.userFromContext(c);
    if (!actor || actor.role !== 'guardian')
      return c.json({ error: 'Only a guardian can remove members.' }, 403);
    if (!familyStore.deletePerson(c.req.param('id')))
      return c.json({ error: 'Member not found.' }, 404);
    return c.json({ ok: true });
  });

  app.get('/memories', (c) => {
    const user = auth?.userFromContext(c);
    return c.json(familyStore.listMemories(user));
  });

  app.post('/memories', async (c) => {
    const actor = auth?.userFromContext(c);
    if (!actor) return c.json({ error: 'Not signed in.' }, 401);
    const parsed = memoryInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Enter a title, visibility, and optional date.' },
        400,
      );
    const person = familyStore.personByUserId(actor.id);
    const peopleIds =
      parsed.data.peopleIds?.filter((id) => familyStore.personById(id)) ?? [];
    const memory = familyStore.createMemory({
      ownerUserId: actor.id,
      ownerName: actor.name,
      title: parsed.data.title,
      body: parsed.data.body,
      visibility: parsed.data.visibility,
      occurredAt: isoToDate(parsed.data.occurredAt),
      peopleIds,
    });
    return c.json(memory, 201);
  });

  app.get('/memories/:id', (c) => {
    const user = auth?.userFromContext(c);
    const memory = familyStore.getMemory(c.req.param('id'));
    if (!memory || !familyStore.canSee(memory, user))
      return c.json({ error: 'Memory not found.' }, 404);
    return c.json(memory);
  });

  app.delete('/memories/:id', async (c) => {
    const actor = auth?.userFromContext(c);
    if (!actor) return c.json({ error: 'Not signed in.' }, 401);
    if (!familyStore.deleteMemory(c.req.param('id'), actor.id))
      return c.json({ error: 'Memory not found or not yours.' }, 403);
    return c.json({ ok: true });
  });

  app.post('/memories/:id/share', async (c) => {
    const actor = auth?.userFromContext(c);
    if (!actor) return c.json({ error: 'Not signed in.' }, 401);
    const parsed = z
      .object({
        personId: z.string().optional().nullable(),
        scope: z
          .enum(['person', 'group', 'family'])
          .optional()
          .default('person'),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Specify scope (person/group/family); optional personId.' },
        400,
      );
    const memory = familyStore.getMemory(c.req.param('id'));
    if (!memory || memory.ownerUserId !== actor.id)
      return c.json({ error: 'Memory not found or not yours.' }, 404);
    const share = familyStore.grantShare(
      c.req.param('id'),
      actor.id,
      parsed.data.personId,
      parsed.data.scope,
    );
    return share
      ? c.json({ share }, 200)
      : c.json({ error: 'Share not created.' }, 400);
  });

  app.delete('/shares/:id', async (c) => {
    const actor = auth?.userFromContext(c);
    if (!actor) return c.json({ error: 'Not signed in.' }, 401);
    const share = familyStore
      .listShares(c.req.param('id').split('#')[0] as any)
      ?.find((s) => s.id === c.req.param('id'));
    if (!share) return c.json({ error: 'Share not found.' }, 404);
    if (!familyStore.revokeShare(c.req.param('id'), actor.id))
      return c.json({ error: 'You did not grant this share.' }, 403);
    return c.json({ ok: true });
  });

  app.post('/subscribe', async (c) => {
    const actor = auth?.userFromContext(c);
    if (!actor) return c.json({ error: 'Not signed in.' }, 401);
    const parsed = z
      .object({ personId: z.string().optional().nullable() })
      .strict()
      .safeParse(c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error: 'Optional personId (person or group) or omit for family-wide.',
        },
        400,
      );
    familyStore.subscribe(actor.id, parsed.data.personId ?? null);
    return c.json({ ok: true });
  });

  app.delete('/unsubscribe', async (c) => {
    const actor = auth?.userFromContext(c);
    if (!actor) return c.json({ error: 'Not signed in.' }, 401);
    const parsed = z
      .object({ personId: z.string().optional().nullable() })
      .strict()
      .safeParse(c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Optional personId.' }, 400);
    if (!familyStore.unsubscribe(actor.id, parsed.data.personId ?? null))
      return c.json({ error: 'Subscription not found.' }, 404);
    return c.json({ ok: true });
  });

  app.get('/notifications', (c) => {
    const actor = auth?.userFromContext(c);
    if (!actor) return c.json({ error: 'Not signed in.' }, 401);
    return c.json(familyStore.listNotifications(actor.id));
  });

  app.get('/notifications/unread', (c) => {
    const actor = auth?.userFromContext(c);
    if (!actor) return c.json({ error: 'Not signed in.' }, 401);
    return c.json({ count: familyStore.unreadCount(actor.id) });
  });

  app.delete('/notifications', async (c) => {
    const actor = auth?.userFromContext(c);
    if (!actor) return c.json({ error: 'Not signed in.' }, 401);
    familyStore.markNotificationsRead(actor.id);
    return c.json({ ok: true });
  });

  app.get('/on-this-day', (c) => {
    const user = auth?.userFromContext(c);
    return c.json(familyStore.onThisDay(user));
  });

  return app;
}
