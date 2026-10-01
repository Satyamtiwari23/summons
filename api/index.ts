import { getApp } from '../server';

let cachedApp: any = null;

export default async function handler(req: any, res: any) {
  if (!cachedApp) {
    const result = await getApp();
    cachedApp = result.app;
  }
  return cachedApp(req, res);
}
