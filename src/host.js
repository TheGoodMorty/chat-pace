// Host half of chat-pace: a deliberate no-op.
//
// The host entry exists so the profile composition loads this package into
// the loader graph; the ClientModuleRegistry then discovers its dsh.client
// declaration and serves the browser bundle at /plugins/chat-pace/client.js.
// The scroll controller lives entirely in the client half (src/client.js).
export const name = 'chat-pace'

export function apply() {}