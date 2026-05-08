export type DashboardNavItem = {
  href: string;
  label: string;
  active?: boolean;
};

export type DashboardNavGroup = {
  id: string;
  label: string;
  items: DashboardNavItem[];
};

function getPath(value: string) {
  return value.split('?')[0] ?? value;
}

function isRouteMatch(target: string, current: string) {
  const targetPath = getPath(target);
  const currentPath = getPath(current);

  if (targetPath === currentPath) return true;
  if (targetPath === '/app') return currentPath === '/app';
  return currentPath.startsWith(`${targetPath}/`);
}

function withActive(items: DashboardNavItem[], currentPath: string) {
  const activeHref = items
    .map((item) => item.href)
    .filter((href) => isRouteMatch(href, currentPath))
    .sort((left, right) => right.length - left.length)[0];

  return items.map((item) => ({ ...item, active: item.href === activeHref }));
}

export function buildAppNavGroups(currentPath: string): DashboardNavGroup[] {
  return [
    {
      id: 'main',
      label: 'Main',
      items: withActive(
        [
          { href: '/app', label: 'Dashboard' },
          { href: '/app/workspaces', label: 'Workspaces' },
          { href: '/app/new-workspace', label: 'New Workspace' },
        ],
        currentPath,
      ),
    },
  ];
}

export function buildWorkspaceNavGroups(workspaceSlug: string, currentPath: string): DashboardNavGroup[] {
  return [
    {
      id: 'workspace',
      label: 'Workspace',
      items: withActive(
        [
          { href: `/workspace/${workspaceSlug}`, label: 'Dashboard' },
          { href: `/workspace/${workspaceSlug}/onboarding`, label: 'Onboarding' },
          { href: `/workspace/${workspaceSlug}/projects`, label: 'Projects' },
          { href: `/workspace/${workspaceSlug}/backups`, label: 'Backups' },
        ],
        currentPath,
      ),
    },
    {
      id: 'settings',
      label: 'Settings',
      items: withActive(
        [
          { href: `/workspace/${workspaceSlug}/settings/members`, label: 'Members' },
          { href: `/workspace/${workspaceSlug}/settings/audit-log`, label: 'Audit Log' },
        ],
        currentPath,
      ),
    },
  ];
}
