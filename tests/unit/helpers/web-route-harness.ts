export type RouteHandler = (req: unknown, res: unknown, next?: () => void) => void | Promise<void>;

export interface CapturedRoute {
  path: string;
  handler: RouteHandler;
}

export interface RouteAppHarness {
  app: {
    use: (...args: unknown[]) => undefined;
    get: (route: string, ...handlers: RouteHandler[]) => void;
    post: (route: string, ...handlers: RouteHandler[]) => void;
    put: (route: string, ...handlers: RouteHandler[]) => void;
    patch: (route: string, ...handlers: RouteHandler[]) => void;
    delete: (route: string, ...handlers: RouteHandler[]) => void;
  };
  useRoutes: RouteHandler[];
  getRouteList: CapturedRoute[];
  postRouteList: CapturedRoute[];
  putRouteList: CapturedRoute[];
  patchRouteList: CapturedRoute[];
  deleteRouteList: CapturedRoute[];
  getRoutes: Map<string, RouteHandler>;
  postRoutes: Map<string, RouteHandler>;
  putRoutes: Map<string, RouteHandler>;
  patchRoutes: Map<string, RouteHandler>;
  deleteRoutes: Map<string, RouteHandler>;
  getRouteCounts: Map<string, number>;
}

export interface ResponseRecorder {
  statusCode: number;
  payload: unknown;
  body: unknown;
  downloaded: { filePath: string; filename: string } | undefined;
  contentType: string;
  redirectedTo: string;
  status: (code: number) => ResponseRecorder;
  json: (data: unknown) => ResponseRecorder;
  send: (data: unknown) => ResponseRecorder;
  download: (filePath: string, filename: string) => ResponseRecorder;
  redirect: (path: string) => ResponseRecorder;
  sendFile: (path: string) => ResponseRecorder;
  setHeader: () => ResponseRecorder;
  type: (value: string) => ResponseRecorder;
}

export function createRouteAppHarness(): RouteAppHarness {
  const useRoutes: RouteHandler[] = [];
  const getRouteList: CapturedRoute[] = [];
  const postRouteList: CapturedRoute[] = [];
  const putRouteList: CapturedRoute[] = [];
  const patchRouteList: CapturedRoute[] = [];
  const deleteRouteList: CapturedRoute[] = [];
  const getRoutes = new Map<string, RouteHandler>();
  const postRoutes = new Map<string, RouteHandler>();
  const putRoutes = new Map<string, RouteHandler>();
  const patchRoutes = new Map<string, RouteHandler>();
  const deleteRoutes = new Map<string, RouteHandler>();
  const getRouteCounts = new Map<string, number>();
  const app = {
    use: (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg === 'function') {
          useRoutes.push(arg as RouteHandler);
        }
      }
      return undefined;
    },
    get: (route: string, ...handlers: RouteHandler[]) => {
      const handler = handlers[handlers.length - 1];
      getRouteCounts.set(route, (getRouteCounts.get(route) ?? 0) + 1);
      getRoutes.set(route, handler);
      getRouteList.push({ path: route, handler });
    },
    post: (route: string, ...handlers: RouteHandler[]) => {
      const handler = handlers[handlers.length - 1];
      postRoutes.set(route, handler);
      postRouteList.push({ path: route, handler });
    },
    put: (route: string, ...handlers: RouteHandler[]) => {
      const handler = handlers[handlers.length - 1];
      putRoutes.set(route, handler);
      putRouteList.push({ path: route, handler });
    },
    patch: (route: string, ...handlers: RouteHandler[]) => {
      const handler = handlers[handlers.length - 1];
      patchRoutes.set(route, handler);
      patchRouteList.push({ path: route, handler });
    },
    delete: (route: string, ...handlers: RouteHandler[]) => {
      const handler = handlers[handlers.length - 1];
      deleteRoutes.set(route, handler);
      deleteRouteList.push({ path: route, handler });
    },
  };
  return {
    app,
    useRoutes,
    getRouteList,
    postRouteList,
    putRouteList,
    patchRouteList,
    deleteRouteList,
    getRoutes,
    postRoutes,
    putRoutes,
    patchRoutes,
    deleteRoutes,
    getRouteCounts,
  };
}

export function createResponseRecorder(): ResponseRecorder {
  const recorder: ResponseRecorder = {
    statusCode: 200,
    payload: undefined,
    body: undefined,
    downloaded: undefined,
    contentType: '',
    redirectedTo: '',
    status(code: number) {
      recorder.statusCode = code;
      return recorder;
    },
    json(data: unknown) {
      recorder.payload = data;
      recorder.body = data;
      return recorder;
    },
    send(data: unknown) {
      recorder.payload = data;
      recorder.body = data;
      return recorder;
    },
    download(filePath: string, filename: string) {
      recorder.downloaded = { filePath, filename };
      return recorder;
    },
    redirect(path: string) {
      recorder.redirectedTo = path;
      recorder.body = { redirect: path };
      return recorder;
    },
    sendFile(path: string) {
      recorder.body = { file: path };
      return recorder;
    },
    setHeader() {
      return recorder;
    },
    type(value: string) {
      recorder.contentType = value;
      return recorder;
    },
  };
  return recorder;
}
