import { expect, it } from 'vitest';
import {
  attachmentSize,
  messageContent,
  readAttachment,
} from '../src/client/attachments';

it('inlines text files into the message', async () => {
  const file = new File(['# Title\nhello'], 'notes.md', {
    type: 'text/markdown',
  });
  const item = await readAttachment(file);
  expect(item).toMatchObject({ kind: 'text', name: 'notes.md' });
  const content = messageContent('Summarize', [item]);
  expect(typeof content).toBe('string');
  expect(content).toContain('Summarize');
  expect(content).toContain('[Attached file: notes.md]');
  expect(content).toContain('hello');
});
it('recognizes code files without a mime type and refuses binaries', async () => {
  expect((await readAttachment(new File(['x=1'], 'a.py'))).kind).toBe('text');
  await expect(
    readAttachment(
      new File([new Uint8Array([1, 2])], 'a.zip', { type: 'application/zip' }),
    ),
  ).rejects.toThrow(/only images and text/);
  await expect(
    readAttachment(new File(['a\u0000b'], 'bin.txt', { type: 'text/plain' })),
  ).rejects.toThrow(/not a text file/);
});
it('sends images as AG-UI image parts and sizes attachments', () => {
  const items = [
    {
      id: '1',
      kind: 'image' as const,
      name: 'p.jpg',
      mimeType: 'image/jpeg',
      data: 'QUJD',
      preview: 'data:image/jpeg;base64,QUJD',
    },
  ];
  const content = messageContent('', items);
  expect(content).toEqual([
    { type: 'text', text: 'See the attached image.' },
    {
      type: 'image',
      source: { type: 'data', value: 'QUJD', mimeType: 'image/jpeg' },
    },
  ]);
  expect(attachmentSize(items)).toBe(4);
});
