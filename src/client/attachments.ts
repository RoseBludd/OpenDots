export type Attachment =
  | {
      id: string;
      kind: 'image';
      name: string;
      mimeType: string;
      data: string;
      preview: string;
    }
  | { id: string; kind: 'text'; name: string; text: string };

// The server rejects API requests over 1MB, so keep all attachments well under it.
export const MAX_ATTACHMENT_BYTES = 700_000;
const MAX_TEXT_CHARS = 100_000;
const TEXT_EXT =
  /\.(txt|md|markdown|json|csv|tsv|ya?ml|toml|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|sh|sql|log|env|ini|cfg)$/i;

function shrinkImage(file: File): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Image could not be processed.'));
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve({
        data: canvas.toDataURL('image/jpeg', 0.82).split(',')[1] ?? '',
        mimeType: 'image/jpeg',
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`${file.name || 'Image'} is not a readable image.`));
    };
    img.src = url;
  });
}

export async function readAttachment(file: File): Promise<Attachment> {
  const id = crypto.randomUUID();
  const name = file.name || 'pasted-image';
  if (file.type.startsWith('image/')) {
    const { data, mimeType } = await shrinkImage(file);
    return {
      id,
      kind: 'image',
      name,
      mimeType,
      data,
      preview: `data:${mimeType};base64,${data}`,
    };
  }
  if (
    file.type.startsWith('text/') ||
    file.type === 'application/json' ||
    TEXT_EXT.test(name)
  ) {
    const text = await file.text();
    if (text.includes('\u0000')) throw new Error(`${name} is not a text file.`);
    return { id, kind: 'text', name, text: text.slice(0, MAX_TEXT_CHARS) };
  }
  throw new Error(`${name}: only images and text/code files can be attached.`);
}

export function attachmentSize(items: Attachment[]) {
  return items.reduce(
    (sum, item) =>
      sum + (item.kind === 'image' ? item.data.length : item.text.length),
    0,
  );
}

/** Builds AG-UI user message content: a string when there are no images. */
export function messageContent(text: string, items: Attachment[]) {
  const files = items.filter((item) => item.kind === 'text');
  const body = [
    text,
    ...files.map(
      (f) =>
        `\n\n[Attached file: ${f.name}]\n\`\`\`\n${f.kind === 'text' ? f.text : ''}\n\`\`\``,
    ),
  ]
    .join('')
    .trim();
  const images = items.filter((item) => item.kind === 'image');
  if (!images.length) return body;
  return [
    { type: 'text' as const, text: body || 'See the attached image.' },
    ...images.map((i) => ({
      type: 'image' as const,
      source: {
        type: 'data' as const,
        value: i.kind === 'image' ? i.data : '',
        mimeType: i.kind === 'image' ? i.mimeType : '',
      },
    })),
  ];
}
