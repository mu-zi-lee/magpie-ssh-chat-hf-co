// Developer-only live check: a real AI SDK Agent copies a fixture in a temporary
// directory. It cannot access project files or execute shell commands.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ToolLoopAgent, tool, jsonSchema, stepCountIs } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createBridge } from '../src/bridge.mjs';
import { MODEL } from '../src/protocol.mjs';

const directory = await mkdtemp(join(tmpdir(), 'magpie-hf-agent-'));
const fixture = Array.from({ length: 12 }, (_, i) => `  console.log("第${i + 1}行：世界", "quote:\\" backslash:\\\\ _*[]");`).join('\n') + '\n';
const report = { at: new Date().toISOString(), model: MODEL, requests: [], tools: [] };
const bridge = createBridge({ stateDir: resolve('.local/ssh') });
const provider = createOpenAICompatible({ name: 'hf-ssh', apiKey: 'anonymous', baseURL: 'http://localhost/v1',
  fetch: async (input, init) => {
    const started = Date.now();
    const response = await bridge.fetch(input, init);
    report.requests.push({ status: response.status, headerMs: Date.now() - started });
    return response;
  },
});
const pathSchema = { type: 'string', enum: ['source.txt', 'output.txt'] };
const agent = new ToolLoopAgent({
  model: provider.chatModel(MODEL), maxRetries: 0, maxOutputTokens: 1000, stopWhen: stepCountIs(3),
  prepareStep: ({ stepNumber }) => ({ toolChoice: stepNumber < 2 ? { type: 'tool', toolName: stepNumber === 0 ? 'read_file' : 'write_file' } : 'none' }),
  tools: {
    read_file: tool({ description: 'Read the test fixture. Only source.txt or output.txt is permitted.',
      inputSchema: jsonSchema({ type: 'object', properties: { path: pathSchema }, required: ['path'], additionalProperties: false }),
      execute: async ({ path }) => {
        assert.ok(['source.txt', 'output.txt'].includes(path));
        report.tools.push({ name: 'read_file', path });
        return await readFile(join(directory, path), 'utf8');
      },
    }),
    write_file: tool({ description: 'Write the copied test content to output.txt.',
      inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string', enum: ['output.txt'] }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false }),
      execute: async ({ path, content }) => {
        assert.equal(path, 'output.txt');
        // Fail before writing if the model changed whitespace, Unicode or escapes.
        assert.equal(content, fixture);
        await writeFile(join(directory, path), content);
        report.tools.push({ name: 'write_file', path, characters: content.length });
        return { success: true, characters: content.length };
      },
    }),
  },
});

try {
  await writeFile(join(directory, 'source.txt'), fixture);
  const result = await agent.stream({ prompt: 'Read source.txt, then copy its entire contents exactly to output.txt with write_file. Preserve every space, newline, quote, backslash and Unicode character. After the tool confirms success, reply COPY_OK.', abortSignal: AbortSignal.timeout(480000) });
  for await (const part of result.fullStream) if (part.type === 'error' || part.type === 'tool-error') throw part.error;
  const text = await result.text;
  assert.equal(await readFile(join(directory, 'output.txt'), 'utf8'), fixture);
  assert.match(text, /COPY_OK/);
  assert.deepEqual(report.tools.map(item => item.name), ['read_file', 'write_file']);
  report.ok = true;
  report.answer = text;
  console.log(`PASS real streaming AI SDK Agent: read → write → final answer; ${fixture.length} characters copied exactly`);
} catch (error) {
  report.ok = false; report.error = error.message;
  console.error(error);
  process.exitCode = 1;
} finally {
  report.elapsedMs = Date.now() - Date.parse(report.at);
  await mkdir('.local', { recursive: true });
  await writeFile('.local/smoke-agent.json', JSON.stringify(report, null, 2));
  await rm(directory, { recursive: true, force: true });
}
