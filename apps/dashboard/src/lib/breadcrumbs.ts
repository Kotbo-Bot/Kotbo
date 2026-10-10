import { allPages } from './config/pages';
import { m } from './i18n';

export type Crumb = { name: string; href: string };

/**
 * Resolves a route into its ancestor trail.
 *
 * Shared by the desktop breadcrumb strip and the mobile top bar, which needs
 * the same data to label the page and point its back button at the parent.
 */
export function buildCrumbs(path: string): Crumb[] {
  if (!path || path === '/' || path === '/login') return [];

  const list: Crumb[] = [{ name: m.bc_home(), href: '/' }];
  const segments = path.split('/').filter(Boolean);

  if (segments[0] === 'events') {
    list.push({ name: m.bc_events(), href: '/events' });
    if (segments[1] === 'edit' && segments[2]) {
      list.push({ name: m.bc_edit(), href: path });
    } else if (segments[1] === 'control' && segments[2]) {
      list.push({ name: m.bc_supervise(), href: path });
    }
  } else if (segments[0] === 'invitations' && segments[1]) {
    list.push({ name: m.bc_invitations(), href: '/invitations' });
    list.push({ name: m.bc_detail({ id: segments[1] }), href: path });
  } else if (segments[0] === 'profile' && segments[1]) {
    list.push({ name: m.bc_members(), href: '/members' });
    list.push({ name: m.bc_profile(), href: path });
  } else if (segments[0] === 'module-settings' && segments[1]) {
    list.push({ name: m.bc_modules(), href: '/modules' });
    const moduleNames: Record<string, string> = {
      regulation: m.bc_module_regulation(),
      sanctions: m.bc_module_sanctions(),
      logs: m.bc_module_logs(),
      recruitment: m.bc_module_recruitment(),
      tickets: m.bc_module_tickets(),
      meetings: m.bc_module_meetings(),
      dailyalgo: m.bc_module_dailyalgo(),
    };
    list.push({ name: moduleNames[segments[1]] || segments[1], href: path });
  } else if (segments[0] === 'admin') {
    list.push({ name: m.bc_admin(), href: '/admin' });
    if (segments[1]) {
      const adminNames: Record<string, string> = {
        servers: m.bc_admin_servers(),
        shards: m.bc_admin_shards(),
        security: m.bc_admin_security(),
        content: m.bc_admin_content(),
        config: m.bc_admin_config(),
        activation: m.bc_admin_activation(),
        modules: m.bc_admin_modules(),
      };
      list.push({ name: adminNames[segments[1]] || segments[1], href: path });
    }
  } else {
    const matchedPage = allPages.find((page) => page.href.split('?')[0] === `/${segments[0]}`);

    if (matchedPage) {
      list.push({ name: matchedPage.name, href: matchedPage.href });
    } else {
      const name = segments[0].charAt(0).toUpperCase() + segments[0].slice(1).replace(/-/g, ' ');
      list.push({ name, href: `/${segments[0]}` });
    }
  }

  return list;
}
