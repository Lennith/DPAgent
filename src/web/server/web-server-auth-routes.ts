import express, { Request, Response } from 'express';

interface AuthRouteDependencies {
  app: express.Express;
  authServices: {
    getStatus: (req: Request) => { required: boolean; authenticated: boolean; local: boolean; configured: boolean };
    handleLogin: (password: string, req: Request) => { success: boolean; cookie?: string };
    handleLogout: () => string;
  };
}

export function registerAuthRoutes(deps: AuthRouteDependencies): void {
  deps.app.get('/api/auth/status', (req: Request, res: Response) => {
    const status = deps.authServices.getStatus(req);
    res.json(status);
  });

  deps.app.post('/api/auth/login', (req: Request, res: Response) => {
    const { password } = req.body ?? {};
    if (typeof password !== 'string' || password.trim().length === 0) {
      return res.status(400).json({ error: 'Password is required' });
    }
    const result = deps.authServices.handleLogin(password.trim(), req);
    if (!result.success) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    if (result.cookie) {
      res.setHeader('Set-Cookie', result.cookie);
    }
    res.json({ success: true });
  });

  deps.app.post('/api/auth/logout', (_req: Request, res: Response) => {
    const cookie = deps.authServices.handleLogout();
    res.setHeader('Set-Cookie', cookie);
    res.json({ success: true });
  });
}
