import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validators,
  maxBytes,
  schemaById,
  schemaByName,
  FRAME_NAMES,
  type FrameName,
} from '../src/index.ts';

test('every schema example validates against its own compiled validator', () => {
  for (const name of FRAME_NAMES) {
    const schema = schemaByName(name);
    const examples = (schema.examples ?? []) as unknown[];
    assert.ok(examples.length > 0, `frame "${name}" has no examples[] to check`);
    const validate = validators[name];
    for (let i = 0; i < examples.length; i++) {
      const ok = validate(examples[i]);
      assert.ok(
        ok,
        `frame "${name}" example[${i}] failed validation: ${JSON.stringify(validate.errors)}`,
      );
    }
  }
});

test('maxBytes returns the schema x-max-frame-bytes for every frame', () => {
  const expected: Record<FrameName, number> = {
    hello: 2048,
    observation: 16384,
    action: 8192,
    ack: 4096,
    reject: 2048,
    match_end: 4096,
    thought: 512,
    session_superseded: 1024,
    session_revoked: 1024,
    error: 4096,
    oauth_error: 2048,
  };
  for (const name of FRAME_NAMES) {
    assert.equal(maxBytes(name), expected[name], `maxBytes(${name})`);
    // and it must equal the value inside the loaded schema
    assert.equal(maxBytes(name), schemaByName(name)['x-max-frame-bytes']);
  }
});

test('schemaById resolves each frame $id', () => {
  for (const name of FRAME_NAMES) {
    const schema = schemaByName(name);
    const byId = schemaById(schema.$id);
    assert.ok(byId, `schemaById(${schema.$id}) returned undefined`);
    assert.equal(byId, schema);
  }
  assert.equal(schemaById('wot:does-not-exist:1'), undefined);
});

test('a malformed frame is rejected (fog/additionalProperties guard)', () => {
  // hello requires token+mode; omit them and add a stray field.
  const bad = { t: 'hello', protocol_version: '1.0', leak: 'x' };
  assert.equal(validators.hello(bad), false);
});
