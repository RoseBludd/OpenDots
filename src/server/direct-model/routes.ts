// Routes mounted at /api in direct-model mode (no Platform). Shapes follow
// workspace-routes.ts (/workspace, /conversations) so clients keep working;
// Intelligence-only features answer 501 instead of falling through to 404.
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { DirectModel, DirectModelError } from './index.js';
import { dotLookSchema, dotModelSchema } from '../dot-model.js';
import { dotSchema } from '../workspace-routes.js';

const requiresIntelligence = (feature: string) => ({
  error: `${feature} requires Intelligence (INTELLIGENCE_API_KEY). This server is running in direct-model mode, which supports Dot conversations and tasks.`,
  mode: 'direct-model',
});

/** Name and instructions only, with the same limits as the full Dot editor. */
const dotText = dotSchema.pick({ name: true, instructions: true }).strict();

const message = z
  .object({
    content: z.string().trim().min(1).max(20_000),
    stream: z.boolean().optional(),
  })
  .strict();

export function directModelRoutes(direct: DirectModel) {
  const app = new Hono();
  const { workspace } = direct;
  const failure = (error: unknown) =>
    error instanceof DirectModelError
      ? error.message
      : 'The model request failed. Check the server configuration and try again.';

  app.get('/workspace', (c) =>
    c.json({
      spaces: workspace.spaces(),
      dots: workspace.dots(),
      conversations: workspace.conversations(),
      setup: direct.setup(),
      calls: [],
      mode: direct.mode,
      model: {
        model: direct.options.model.model,
        fallbackModel: direct.options.model.fallbackModel ?? null,
      },
    }),
  );
  app.post('/conversations', async (c) => {
    const data = z
      .object({
        dotId: z.string(),
        title: z.string().trim().min(1).max(120).default('A new thought'),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Select a Dot and a conversation title.' }, 400);
    if (!workspace.dot(data.data.dotId))
      return c.json({ error: 'Dot not found.' }, 404);
    return c.json(
      direct.createConversation(data.data.dotId, data.data.title),
      201,
    );
  });
  const owned = (id: string) => {
    try {
      return workspace.requireThread(id);
    } catch {
      return undefined;
    }
  };
  app.get('/conversations/:id/messages', (c) => {
    const thread = owned(c.req.param('id'));
    if (!thread) return c.json({ error: 'Conversation not found.' }, 404);
    return c.json({ thread, messages: direct.threads.messages(thread.id) });
  });
  app.post('/conversations/:id/messages', async (c) => {
    const thread = owned(c.req.param('id'));
    if (!thread) return c.json({ error: 'Conversation not found.' }, 404);
    const data = message.safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'A message between 1 and 20,000 characters is required.' },
        400,
      );
    const wantsStream =
      data.data.stream ??
      (c.req.header('accept') ?? '').includes('text/event-stream');
    if (!wantsStream) {
      try {
        const reply = await direct.turn(thread.id, data.data.content, {
          signal: c.req.raw.signal,
        });
        return c.json(
          { message: reply.assistant, user: reply.user, model: reply.model },
          201,
        );
      } catch (error) {
        return c.json({ error: failure(error) }, 502);
      }
    }
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort(new Error('Client disconnected.')));
      try {
        const reply = await direct.turn(thread.id, data.data.content, {
          signal: controller.signal,
          onDelta: (text) => {
            void stream.writeSSE({
              event: 'delta',
              data: JSON.stringify({ text }),
            });
          },
        });
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({
            message: reply.assistant,
            model: reply.model,
          }),
        });
      } catch (error) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: failure(error) }),
        });
      }
    });
  });
  app.put('/dots/:id/look', async (c) => {
    const data = dotLookSchema.safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'Use pinned (true/false) and hue (0-359 or null).' },
        400,
      );
    if (!workspace.dot(c.req.param('id')))
      return c.json({ error: 'Dot not found.' }, 404);
    return c.json(workspace.setDotLook(c.req.param('id'), data.data));
  });
  app.put('/dots/:id/model', async (c) => {
    const data = dotModelSchema.safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        {
          error:
            'Choose a model (cadis-free or cadis) and an optional desk name (lowercase letters, digits, dashes).',
        },
        400,
      );
    if (!workspace.dot(c.req.param('id')))
      return c.json({ error: 'Dot not found.' }, 404);
    return c.json(workspace.setDotModel(c.req.param('id'), data.data));
  });
  // Rename / re-instruct a Dot. Everything else (spaces, learning, avatar,
  // project folder) needs Intelligence and stays as it is.
  app.patch('/dots/:id', async (c) => {
    const data = dotText.safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        {
          error:
            'Use a name (1-40 characters) and instructions (3-2000 characters).',
        },
        400,
      );
    const current = workspace.dot(c.req.param('id'));
    if (!current) return c.json({ error: 'Dot not found.' }, 404);
    return c.json(
      workspace.updateDot(current.id, {
        ...data.data,
        researchAllowed: current.researchAllowed,
        memoryAllowed: current.memoryAllowed,
      }),
    );
  });
  app.get('/conversations/:id/capture', (c) =>
    owned(c.req.param('id'))
      ? c.json(workspace.capture(c.req.param('id')))
      : c.json({ error: 'Conversation not found.' }, 404),
  );
  app.all('/copilotkit', (c) =>
    c.json(requiresIntelligence('Live chat streaming'), 501),
  );
  app.all('/copilotkit/*', (c) =>
    c.json(requiresIntelligence('Live chat streaming'), 501),
  );
  app.all('/voice/*', (c) => c.json(requiresIntelligence('Voice'), 501));
  app.all('/dots/:id/computer', (c) =>
    c.json(requiresIntelligence('Computers'), 501),
  );
  app.all('/dots/:id/computer/*', (c) =>
    c.json(requiresIntelligence('Computers'), 501),
  );
  app.all('/spaces/:spaceId/pages', (c) =>
    c.json(requiresIntelligence('Pages'), 501),
  );
  app.all('/spaces/:spaceId/pages/*', (c) =>
    c.json(requiresIntelligence('Pages'), 501),
  );
  app.all('/conversations/:id/page', (c) =>
    c.json(requiresIntelligence('Pages'), 501),
  );
  app.all('/conversations/:id/page-context', (c) =>
    c.json(requiresIntelligence('Pages'), 501),
  );
  app.all('/conversations/:id/reviewed-page', (c) =>
    c.json(requiresIntelligence('Pages'), 501),
  );
  app.all('/conversations/:id/reviewed-page/*', (c) =>
    c.json(requiresIntelligence('Pages'), 501),
  );
  app.all('/spaces', (c) =>
    c.json(requiresIntelligence('Editing Spaces'), 501),
  );
  app.all('/dots', (c) => c.json(requiresIntelligence('Editing Dots'), 501));
  app.all('/dots/:id', (c) =>
    c.json(requiresIntelligence('Editing Dots'), 501),
  );
  return app;
}
