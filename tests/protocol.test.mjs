import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL, MAX_REPLY_CHARS, MAX_PROMPT_CHARS, prepareRequest, parseReply, assistantArea } from '../src/protocol.mjs';

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

test('reusing a tool schema id across Agent turns still validates each reply', () => {
  const input = body();
  input.tools[0].function.parameters.$id = 'https://example.test/read-file-schema';
  for (let i = 0; i < 3; i++) {
    const req = prepareRequest(JSON.parse(JSON.stringify(input)));
    const reply = parseReply(envelope(req, { content: null, tool_calls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] }), req);
    assert.equal(reply.tool_calls[0].function.name, 'read_file');
    assert.throws(() => parseReply(envelope(req, { content: null, tool_calls: [{ name: 'read_file', arguments: { path: 1 } }] }), req), { code: 'invalid_tool_call' });
  }
});

test('rejects hallucinated tools, invalid arguments and incomplete replies', () => {
  const req = prepareRequest(body());
  for (const call of [{ name: 'shell', arguments: { command: 'ls' } }, { name: 'read_file', arguments: { path: 7 } }, { name: 'read_file', arguments: { path: 'a', extra: true } }]) {
    assert.throws(() => parseReply(envelope(req, { content: null, tool_calls: [call] }), req));
  }
  assert.throws(() => parseReply(req.start + '\n{"content":', req));
  assert.throws(() => parseReply(envelope(req, { content: '', tool_calls: [] }), req));
  assert.throws(() => parseReply(envelope(req, { content: 'x'.repeat(MAX_REPLY_CHARS), tool_calls: [] }), req), { code: 'reply_too_large' });
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
  assert.throws(() => prepareRequest({ ...body(), stop: ['end'] }), { status: 400 });
  assert.throws(() => prepareRequest({ ...body(), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] }), { status: 400 });
  assert.throws(() => prepareRequest(body(), { maxPromptChars: 10 }), { status: 400 });
  assert.throws(() => prepareRequest({ ...body(), parallel_tool_calls: 'false' }), { status: 400 });
});

test('common gateway defaults work without settings changes and are disclosed as soft or ignored', () => {
  const request = prepareRequest({ ...body(), temperature: 0.2, max_tokens: 100 });
  assert.deepEqual(request.ignoredParameters, ['temperature']);
  assert.equal(request.tokenTarget, 100);
  assert.match(request.prompt, /at most 100 output tokens/);
  assert.throws(() => prepareRequest({ ...body(), max_tokens: -1 }), { status: 400 });
  assert.throws(() => prepareRequest({ ...body(), temperature: 'hot' }), { status: 400 });
});

test('oversized history fails before SSH even when a higher limit is configured', () => {
  const input = { ...body(), messages: [{ role: 'user', content: 'x'.repeat(MAX_PROMPT_CHARS) + 'LATEST_INSTRUCTION' }] };
  assert.throws(() => prepareRequest(input), { status: 400, code: 'context_length_exceeded' });
  assert.throws(() => prepareRequest(input, { maxPromptChars: 60000 }), { status: 400, code: 'context_length_exceeded' });
});

test('terminal extraction ignores echoed prompt markers and UI footer', () => {
  const req = prepareRequest(body());
  assert.equal(assistantArea(`🤗 ssh chat ${MODEL} @anonymous\n you\n${req.prompt}\n┃ Ask anything`), '');
  assert.equal(assistantArea(`🤗 ssh chat ${MODEL}\n you\n${req.prompt}\n 🤗 ${MODEL}\n ${envelope(req, { content: 'hi', tool_calls: [] })}\n┃ Ask anything`), envelope(req, { content: 'hi', tool_calls: [] }));
});
