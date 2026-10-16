import type { Role } from './lib/types';
import { ROLE_META, linkFor } from './lib/portal';

/** Where each role lands after signing in — inside its own door. */
export const homeFor = (role: Role) => linkFor(role, ROLE_META[role].home);

/** The screens each role may open (URS §4.3 plus the client additions). */
export const SCREENS: Record<Role, string[]> = {
  super_admin: ['/companies', '/subscriptions', '/usage', '/audit', '/security', '/support', '/profile'],
  client_admin: ['/leads', '/scan', '/scan-v2', '/my-leads', '/team', '/settings', '/settings/crm', '/support', '/security', '/profile'],
  staff: ['/scan', '/scan-v2', '/my-leads', '/security', '/profile'],
};

/** May this role open this screen? Anything else sends them back to their own home. */
export const canSee = (role: Role, path: string) => SCREENS[role].includes(path);
