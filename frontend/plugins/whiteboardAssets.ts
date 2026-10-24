import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import type { Plugin } from 'vite';

/** Serve editor fonts locally; they are fetched only when the editor needs them. */
export function whiteboardAssets(): Plugin {
  const root = resolve(import.meta.dirname, '../node_modules/@excalidraw/excalidraw/dist/prod/fonts');
  return {
    name: 'whiteboard-fonts',
    configureServer(server) {
      server.middlewares.use('/whiteboard/fonts', (req, res, next) => {
        const path = resolve(root, `.${decodeURIComponent((req.url ?? '/').split('?')[0])}`);
        if (!path.startsWith(root + sep) || !path.endsWith('.woff2')) return next();
        res.setHeader('Content-Type', 'font/woff2');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        const stream = createReadStream(path);
        stream.on('error', () => {
          res.statusCode = 404;
          res.end();
        });
        stream.pipe(res);
      });
    },
    generateBundle() {
      for (const file of readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.woff2')) continue;
        const path = resolve(file.parentPath, file.name);
        this.emitFile({
          type: 'asset',
          fileName: `whiteboard/fonts/${relative(root, path).split(sep).join('/')}`,
          source: readFileSync(path),
        });
      }
    },
  };
}
