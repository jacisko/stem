export {
  a,
  argsProblem,
  dispatchLocal,
  hasLocalHandler,
  ipcArgSpecs,
  registerServer,
  serverChannels,
  type ArgSpec,
  type Caller,
  type CallerContext
} from './guard';
export type { IpcDeps } from './deps';
export { registerAuthIpc } from './auth';
export { chatListOf, registerChatsIpc } from './chats';
export { registerDevicesIpc } from './devices';
export { registerUpgradeIpc } from './upgrade';
export { registerMcpIpc } from './mcp';
export { registerMailIpc } from './mail';
export { registerInterStemIpc } from './interstem';
export { registerMemoryIpc } from './memory';
export { memoryCheckLlm, registerMemoryCheckIpc } from './memory-check';
export { registerPersonasIpc } from './personas';
export { registerPinsIpc } from './pins';
export { registerShareIpc } from './share';
export { registerWorkspaceIpc } from './workspace';
