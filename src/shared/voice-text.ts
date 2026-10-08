// Helpers for spoken replies: strip markup a text-to-speech voice would read
// aloud, and split a reply into short sentences so playback can start early.

export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.(\s*\.)+/g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function splitSentences(text: string, max = 240): string[] {
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    let rest = part;
    while (rest.length > max) {
      const cut = Math.max(
        rest.lastIndexOf(', ', max),
        rest.lastIndexOf(' ', max),
      );
      const at = cut > max / 2 ? cut : max;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).replace(/^[,\s]+/, '');
    }
    if (rest) out.push(rest);
  }
  // Merge very short fragments so each synthesis call has some substance.
  const merged: string[] = [];
  for (const sentence of out) {
    const last = merged[merged.length - 1];
    if (last && last.length < 24 && last.length + sentence.length <= max)
      merged[merged.length - 1] = `${last} ${sentence}`;
    else merged.push(sentence);
  }
  return merged;
}
