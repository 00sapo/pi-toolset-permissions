import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { handleModelRelay } from './model-relay.ts';

test('model relay forwards context and serializable stream options', async () => {
 let received: any;
 const server = createServer((req, res) => void handleModelRelay(req, res, 'test-token', async function* (context, signal, options) {
  received = { context, options, aborted: signal.aborted };
  yield {type:'done', message:{role:'assistant', content:[]}};
 }, undefined));
 server.listen(0, '127.0.0.1');
 await once(server, 'listening');
 try {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const context = {messages:[{role:'user',content:'hello'}]};
  const options = {reasoning:'high', temperature:0.2, headers:{'x-opencode-session':'session-123'}, maxTokens:100};
  const response = await fetch(`http://127.0.0.1:${address.port}/model`, {method:'POST', headers:{authorization:'Bearer test-token','content-type':'application/json'},body:JSON.stringify({context,options})});
  assert.equal(response.status,200);
  await response.text();
  assert.deepEqual(received, {context, options, aborted:false});
 } finally { server.close(); await once(server,'close'); }
});
