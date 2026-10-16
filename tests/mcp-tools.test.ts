import { describe, it, expect } from 'vitest';
import { mcpTools } from '../src/server/tools/mcp/index.js';

describe('MCP tools', () => {
  it('has read_public_page and search_web tools', () => {
    const names = mcpTools.map((t) => t.name);
    expect(names).toContain('read_public_page');
    expect(names).toContain('search_web');
  });

  it('read_public_page returns source evidence', async () => {
    const tool = mcpTools.find((t) => t.name === 'read_public_page');
    expect(tool).toBeDefined();
    const result = await tool!.execute({ url: 'https://example.com/page' });
    expect(result.title).toBe('Public Page');
    expect(result.url).toBe('https://example.com/page');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toBe('https://example.com/page');
  });

  it('search_web returns search results', async () => {
    const tool = mcpTools.find((t) => t.name === 'search_web');
    expect(tool).toBeDefined();
    const result = await tool!.execute({
      objective: 'test search',
      search_queries: ['test query'],
    });
    expect(result.title).toBe('Web Search Results');
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].url).toBe('https://example.com/result1');
  });

  it('read_public_page validates URL', async () => {
    const tool = mcpTools.find((t) => t.name === 'read_public_page');
    expect(tool).toBeDefined();
    await expect(tool!.execute({ url: 'not-a-url' })).rejects.toThrow();
  });

  it('search_web validates search_queries', async () => {
    const tool = mcpTools.find((t) => t.name === 'search_web');
    expect(tool).toBeDefined();
    await expect(
      tool!.execute({ objective: 'test', search_queries: [] })
    ).rejects.toThrow();
  });
});