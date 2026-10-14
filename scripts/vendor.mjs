import {createRequire} from 'node:module';
import {copyFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const require = createRequire(import.meta.url);
const dest = fileURLToPath(new URL('../dashboard/vendor/', import.meta.url));
mkdirSync(dest, {recursive: true});
for (const [pkg, bundle] of [['vega', 'vega.min.js'], ['vega-lite', 'vega-lite.min.js'], ['vega-embed', 'vega-embed.min.js']]) {
  let root = dirname(require.resolve(pkg));
  while (!existsSync(join(root, 'build', bundle))) {
    const parent = dirname(root);
    if (parent === root) throw new Error('Cannot locate browser bundle for ' + pkg);
    root = parent;
  }
  copyFileSync(join(root, 'build', bundle), join(dest, bundle));
  copyFileSync(join(root, 'LICENSE'), join(dest, pkg + '-LICENSE.txt'));
}
console.log('Vendored browser libraries copied; dashboard needs no external CDN.');
