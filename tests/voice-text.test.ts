import { expect, it } from 'vitest';
import { speakable, splitSentences } from '../src/shared/voice-text.js';

it('strips markdown, links and code so speech reads naturally', () => {
  const spoken = speakable(
    '## Plan\n- **Open** the [docs](https://example.com/docs)\n- Run `npm test`\n\n```sh\nrm -rf x\n```\nSee https://example.com now.',
  );
  expect(spoken).not.toMatch(/[*#`]|https?:/);
  expect(spoken).toContain('Open the docs');
  expect(spoken).toContain('Run npm test');
  expect(spoken).toContain('code omitted');
  expect(spoken).toContain('a link');
});

it('splits replies into short sentences and merges tiny fragments', () => {
  expect(splitSentences('Sure. I can do that for you today. Ready?')).toEqual([
    'Sure. I can do that for you today.',
    'Ready?',
  ]);
  const long = `${'word '.repeat(120)}end.`;
  const parts = splitSentences(long, 100);
  expect(parts.length).toBeGreaterThan(3);
  expect(parts.every((part) => part.length <= 100)).toBe(true);
  expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long.trim());
});
