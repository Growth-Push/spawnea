import {
  createCatalogProjectPathLocator,
  isOnePasswordReference,
  maskSensitiveString,
  type CatalogReloadResult,
  type CatalogState,
  type OperationalCatalog,
} from '@spawnea/domain';

export function sanitizeCatalogForRenderer(catalog: OperationalCatalog | null): OperationalCatalog | null {
  if (!catalog) return null;
  return {
    ...catalog,
    hosts: Object.fromEntries(Object.entries(catalog.hosts).map(([hostId, host]) => {
      const credentialBackedSsh = Boolean(host.ssh && (
        isOnePasswordReference(host.ssh.target)
        || (host.ssh.user ? isOnePasswordReference(host.ssh.user) : false)
        || (typeof host.ssh.port === 'string' && isOnePasswordReference(host.ssh.port))
      ));
      return [hostId, {
        ...host,
        ssh: host.ssh
          ? {
              target: credentialBackedSsh ? '1Password-backed' : host.ssh.target,
              user: host.ssh.user && !isOnePasswordReference(host.ssh.user) ? host.ssh.user : undefined,
              port: typeof host.ssh.port === 'number' ? host.ssh.port : undefined,
            }
          : undefined,
        projects: Object.fromEntries(Object.entries(host.projects).map(([projectId, project]) => [
          projectId,
          {
            ...project,
            path: isOnePasswordReference(project.path)
              ? createCatalogProjectPathLocator(hostId, projectId)
              : project.path,
          },
        ])),
      }];
    })),
  };
}

export function sanitizeCatalogStateForRenderer(state: CatalogState): CatalogState {
  return {
    ...state,
    catalog: sanitizeCatalogForRenderer(state.catalog),
    errors: state.errors?.map((error) => ({ ...error, message: maskSensitiveString(error.message) })) ?? null,
  };
}

export function sanitizeCatalogResultForRenderer(result: CatalogReloadResult): CatalogReloadResult {
  return {
    ...result,
    catalog: sanitizeCatalogForRenderer(result.catalog),
    errors: result.errors?.map((error) => ({ ...error, message: maskSensitiveString(error.message) })) ?? null,
  };
}
