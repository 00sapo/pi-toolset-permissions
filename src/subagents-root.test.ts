import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subagentsRunRoot } from './subagents-root.ts';

test('the run directory matches the pi-subagents default for this uid', () => {
 assert.equal(subagentsRunRoot({}, {tmpdir:'/tmp', uid:1000}), '/tmp/pi-subagents-uid-1000');
 assert.equal(subagentsRunRoot({}, {tmpdir:'/var/tmp', uid:0}), '/var/tmp/pi-subagents-uid-0');
});

test('a configured run directory wins, so both sides can be pinned to one path', () => {
 assert.equal(subagentsRunRoot({PI_SUBAGENTS_TEMP_ROOT:'/run/shared/runs'}, {tmpdir:'/tmp', uid:1000}), '/run/shared/runs');
 assert.equal(subagentsRunRoot({PI_SUBAGENTS_TEMP_ROOT:'  /run/shared/runs  '}, {tmpdir:'/tmp', uid:1000}), '/run/shared/runs');
});

test('an unknown uid falls back to the shared scope', () => {
 assert.equal(subagentsRunRoot({}, {tmpdir:'/tmp'}), '/tmp/pi-subagents-shared');
});
