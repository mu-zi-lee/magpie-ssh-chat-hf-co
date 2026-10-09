import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL, prepareRequest, parseReply, assistantArea } from '../src/protocol.mjs';

const body = () => ({ model: MODEL, messages: [{ role: 'user', content: 'Read a file' }], tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }] });
const envelope = (req, reply) => `${req.start}\n${JSON.stringify(reply)}\n${req.end}`;

test('tool calls validate against the declared schema and retain result history', () => {
  const request = prepareRequest(body());
  const reply = parseReply(envelope(request, { content: null, tool_calls: [{ name: 'read_file', arguments: { path: 'package.json' } }] }), request);
  assert.equal(reply.tool_calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(reply.tool_calls[0].function.arguments), { path: 'package.json' });
  const next = prepareRequest({ ...body(), messages: [...body().messages, reply, { role: 'tool', tool_call_id: reply.tool_calls[0].id, content: 'file contents' }] });
  assert.ok(next.prompt.includes(reply.tool_calls[0].id));
  assert.ok(next.prompt.includes('file contents'));
});

test('rejects hallucinated tools, invalid arguments and incomplete replies', () => {
  const req = prepareRequest(body());
  for (const call of [{ name: 'shell', arguments: { command: 'ls' } }, { name: 'read_file', arguments: { path: 7 } }, { name: 'read_file', arguments: { path: 'a', extra: true } }]) {
    assert.throws(() => parseReply(envelope(req, { content: null, tool_calls: [call] }), req));
  }
  assert.throws(() => parseReply(req.start + '\n{"content":', req));
  assert.throws(() => parseReply(envelope(req, { content: '', tool_calls: [] }), req));
});

test('enforces tool_choice and parallel_tool_calls', () => {
  const reply = { content: null, tool_calls: [{ name: 'read_file', arguments: { path: 'a' } }] };
  const none = prepareRequest({ ...body(), tool_choice: 'none' });
  assert.throws(() => parseReply(envelope(none, reply), none));
  const required = prepareRequest({ ...body(), tool_choice: 'required' });
  assert.throws(() => parseReply(envelope(required, { content: 'hello', tool_calls: [] }), required));
  const serial = prepareRequest({ ...body(), parallel_tool_calls: false });
  assert.throws(() => parseReply(envelope(serial, { ...reply, tool_calls: [...reply.tool_calls, ...reply.tool_calls] }), serial));
});

test('unsupported modalities, controls, model access and excessive prompts fail before SSH', () => {
  assert.throws(() => prepareRequest({ ...body(), model: 'other/model' }), { status: 403, code: 'hf_login_required' });
  assert.throws(() => prepareRequest({ ...body(), temperature: 0.2 }), { status: 400 });
  assert.throws(() => prepareRequest({ ...body(), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] }), { status: 400 });
  assert.throws(() => prepareRequest(body(), { maxPromptChars: 10 }), { status: 400 });
});

test('terminal extraction ignores echoed prompt markers and UI footer', () => {
  const req = prepareRequest(body());
  assert.equal(assistantArea(`🤗 ssh chat ${MODEL} @anonymous\n you\n${req.prompt}\n┃ Ask anything`), '');
  assert.equal(assistantArea(`🤗 ssh chat ${MODEL}\n you\n${req.prompt}\n 🤗 ${MODEL}\n ${envelope(req, { content: 'hi', tool_calls: [] })}\n┃ Ask anything`), envelope(req, { content: 'hi', tool_calls: [] }));
});
