type RouteHandler = (params: Record<string, string>, query: URLSearchParams) => void;

interface RouteDefinition {
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class SimpleRouter {
  private routes: RouteDefinition[] = [];
  private notFoundHandler: (() => void) | null = null;
  private currentPath = '';

  constructor() {
    window.addEventListener('hashchange', () => this.handleHashChange());
  }

  public on(pathPattern: string, handler: RouteHandler): this {
    const paramNames: string[] = [];
    const regexPattern = pathPattern
      .replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
        paramNames.push(name);
        return '([^/]+)';
      })
      .replace(/\*/g, '(.*)');

    const pattern = new RegExp(`^${regexPattern}$`);
    this.routes.push({ pattern, paramNames, handler });
    return this;
  }

  public notFound(handler: () => void): this {
    this.notFoundHandler = handler;
    return this;
  }

  public navigate(hashPath: string): void {
    if (window.location.hash !== hashPath) {
      window.location.hash = hashPath;
    } else {
      this.handleHashChange();
    }
  }

  public start(): void {
    if (!window.location.hash) {
      window.location.hash = '#/';
    } else {
      this.handleHashChange();
    }
  }

  public getCurrentPath(): string {
    return this.currentPath;
  }

  private handleHashChange(): void {
    const rawHash = window.location.hash.slice(1) || '/';
    const [pathPart, queryPart] = rawHash.split('?');
    const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
    const query = new URLSearchParams(queryPart || '');
    this.currentPath = path;

    for (const route of this.routes) {
      const match = path.match(route.pattern);
      if (match) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1] || '');
        });
        route.handler(params, query);
        return;
      }
    }

    if (this.notFoundHandler) {
      this.notFoundHandler();
    }
  }
}
