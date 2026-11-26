import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const hooks = registerHooks({ resolve(specifier, context, next) {
 if (specifier === "@earendil-works/pi-ai") return {url:"data:text/javascript,export const createAssistantMessageEventStream=()=>({});",shortCircuit:true};
 return next(specifier, context);
} });
const { default: innerModel } = await import("./inner-model.ts");
hooks.deregister();

test("sandbox tool hook forwards its own public explanation", async () => {
 const saved = {url:process.env.PI_PARENT_MODEL_URL,token:process.env.PI_BRIDGE_TOKEN,root:process.env.PI_PARENT_RELAY_ROOT,fetch:globalThis.fetch};
 process.env.PI_PARENT_MODEL_URL="http://relay.invalid"; process.env.PI_BRIDGE_TOKEN="test";
 delete process.env.PI_PARENT_RELAY_ROOT;
 const handlers = new Map<string,Function>();
 let payload:any;
 globalThis.fetch = (async (_url:any, options:any) => {payload=JSON.parse(options.body);return Response.json({});}) as typeof fetch;
 const ctx = {sessionManager:{getSessionId:()=>"sandbox-reason-test",getBranch:()=>[
 {type:"message",message:{role:"assistant",content:[{type:"text",text:"Read the child configuration to diagnose its error."}]}},
 {type:"message",message:{role:"assistant",content:[{type:"thinking",thinking:"secret"},{type:"toolCall",name:"read"}]}},
 ]}};
 try {
 innerModel({registerProvider(){},on:(name:string,fn:Function)=>handlers.set(name,fn)} as any);
 handlers.get("session_start")!({},ctx);
 const event={toolName:"read",toolCallId:"child-call",input:{path:"config.ts"}};
 assert.deepEqual(await handlers.get("tool_call")!(event,ctx),{});
 assert.deepEqual(payload,{...event,approvalReason:"Read the child configuration to diagnose its error."});
 assert.doesNotMatch(JSON.stringify(payload),/secret/);
 } finally {
 handlers.get("session_shutdown")?.({},ctx);
 globalThis.fetch=saved.fetch;
 for (const [key,value] of [["PI_PARENT_MODEL_URL",saved.url],["PI_BRIDGE_TOKEN",saved.token],["PI_PARENT_RELAY_ROOT",saved.root]]) {
 if(value===undefined)delete process.env[key!];else process.env[key!]=value;
 }
 }
});
