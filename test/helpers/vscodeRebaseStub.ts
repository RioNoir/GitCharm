// Stand-in for the `vscode` module when exercising GitService outside the extension host.
// Repositories are whatever the test stored on globalThis under GITCHARM_API_REPOS, keyed by root path.

export const GITCHARM_API_REPOS = '__gitcharmApiRepos';

interface ApiRepo {
  rootUri: { fsPath: string };
}

export const Uri = {
  file(fsPath: string) { return { fsPath, scheme: 'file' }; },
};

export const workspace = {
  getConfiguration() {
    return { get(_key: string, fallback?: unknown) { return fallback; } };
  },
};

export const l10n = {
  t(message: string, ...args: unknown[]) {
    return message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)] ?? ''));
  },
};

export const extensions = {
  getExtension() {
    return {
      isActive: true,
      exports: {
        getAPI() {
          return {
            getRepository(uri: { fsPath: string }) {
              const repos = (globalThis as Record<string, Map<string, ApiRepo> | undefined>)[GITCHARM_API_REPOS];
              return repos?.get(uri.fsPath);
            },
            async openRepository() { return undefined; },
          };
        },
      },
    };
  },
};

export const window = {
  async showWarningMessage() { return undefined; },
};

export class EventEmitter {
  event() { return { dispose() {} }; }
  fire() {}
  dispose() {}
}
