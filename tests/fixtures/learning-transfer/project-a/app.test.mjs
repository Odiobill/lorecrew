import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { greeting } from './app.mjs';
test('greets the named visitor', () => assert.equal(greeting('Ada'), 'Hello Ada'));
