import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { receipt } from './mail.mjs';
test('addresses the receipt to the customer', () => assert.equal(receipt('Lin'), 'Thanks Lin'));
