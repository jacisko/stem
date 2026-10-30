import { registerServer, type CallerContext } from './guard';
import type { ServerUpgrader } from '../upgrade';
import type { ServerUpgradeStatus } from '../../shared/types';

/**
 * Settings → Server → Version. `status` is also how a client tells the server
 * which version it runs: every client calls it on launch and now and then after,
 * and the newest version reported is what the server upgrades to (see
 * server/upgrade.ts). Any paired device may start an upgrade — a paired device
 * is a full admin here, and this is no more than devices:revoke already allows.
 */
export function registerUpgradeIpc(upgrader: ServerUpgrader): void {
  registerServer(
    'serverUpgrade:status',
    (_caller: CallerContext, clientVersion?: string): ServerUpgradeStatus => {
      if (typeof clientVersion === 'string') upgrader.noteClientVersion(clientVersion);
      return upgrader.status();
    }
  );
  registerServer('serverUpgrade:start', (): ServerUpgradeStatus => upgrader.start());
  registerServer('serverUpgrade:setAuto', (_e, auto: boolean): ServerUpgradeStatus => upgrader.setAuto(auto));
}
