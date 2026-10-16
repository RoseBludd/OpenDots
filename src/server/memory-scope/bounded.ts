// Byte cap that keeps the start and end of a long text, ported from AgentConnect
// (RoseBludd/agentconnect, packages/daemon/src/memory-plugin/outbox.ts,
// boundedCaptureText) so imported seat memories stay small.
function utf8Head(buffer: Buffer, bytes: number): string {
  return buffer
    .subarray(0, bytes)
    .toString('utf8')
    .replace(/\uFFFD+$/, '');
}
function utf8Tail(buffer: Buffer, bytes: number): string {
  if (bytes <= 0) return '';
  return buffer
    .subarray(buffer.length - bytes)
    .toString('utf8')
    .replace(/^\uFFFD+/, '');
}
export function boundedText(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  const marker = '\n[…truncated…]\n';
  const markerBytes = Buffer.byteLength(marker);
  if (maxBytes <= markerBytes) return utf8Head(buffer, maxBytes);
  const contentBytes = maxBytes - markerBytes;
  const headBytes = Math.ceil(contentBytes / 2);
  return `${utf8Head(buffer, headBytes)}${marker}${utf8Tail(buffer, contentBytes - headBytes)}`;
}
