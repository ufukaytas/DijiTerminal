// 09/01: şema kurallarının iki kopyası (scripts/lib/schema-summary.mjs ve src/shared/schemaRules.ts) aynı davranır.
import { describe, expect, it } from 'vitest';
import * as mjs from '../../scripts/lib/schema-summary.mjs';
import { enumValue, keyName, shapeInto, shapeObject, typeOf } from '@shared/schemaRules';

const VALUES: unknown[] = [
  'assistant', 'api-request-blob', 'system', 'end_turn', 'a:b', 'X1', '', '1abc', 'deadbeef00', 'Bu bir cümle',
  'x'.repeat(41), 'claude-opus-5-5', null, 1, true, {}, [], undefined,
];
const KEYS = [
  'type', 'message', 'toolu_01ABC', 'srvtoolu_x', 'call_1', 'msg_id', 'req_9', '2372ca6c-4a3c-4976-b221-4ce4d67bde8a',
  'deadbeefdeadbeef', 'abc', '1234', '123', 'sessionId',
];

describe('schemaRules ↔ schema-summary.mjs', () => {
  it.each(VALUES.map((v) => [v]))('typeOf/enumValue(%j)', (v) => {
    expect(typeOf(v)).toBe(mjs.typeOf(v));
    expect(enumValue(v)).toBe(mjs.enumValue(v));
  });
  it.each(KEYS.map((k) => [k]))('keyName(%s)', (k) => {
    expect(keyName(k)).toBe(mjs.keyName(k));
  });
  it('shape: aynı anahtar/tip özeti', () => {
    const rec = { type: 'x', message: { usage: { a: 1 }, toolu_01X: 2 }, input: { secret: 'x' }, list: [1], n: null };
    const a = new Map<string, Set<string>>();
    const b = new Map<string, Set<string>>();
    shapeInto(a, rec);
    mjs.shape(b, rec);
    expect(shapeObject(a)).toEqual(shapeObject(b));
    expect(shapeObject(a)['message.‹id›']).toBe('number');
    expect(shapeObject(a)['input.secret']).toBeUndefined();
  });
  it('shapeInto anahtar sınırı', () => {
    const m = new Map<string, Set<string>>();
    shapeInto(m, Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i])), 40);
    expect(m.size).toBe(40);
  });
});
