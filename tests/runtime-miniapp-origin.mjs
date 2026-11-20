// Telegram MCP Starter (M3-origin): the Telegram container shim goes only into the top frame of
// the mini app origin (Telegram clients refuse mini app methods from other origins). No
// Playwright and no network: the init script runs in node:vm on a fake window.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The postimage is an ES module of the package; load its exact bytes without a package.json type.
const shimSource = readFileSync(join(projectRoot, 'runtime/files/dist/miniapp-shim.js'), 'utf8');
const shim = await import(`data:text/javascript;base64,${Buffer.from(shimSource).toString('base64')}`);

function run(script, { origin, top = true }) {
  const win = { innerHeight: 780, innerWidth: 420, location: { origin } };
  win.window = win;
  win.top = top ? win : {};
  win.setTimeout = (fn) => fn();
  vm.runInNewContext(script, win);
  return win;
}

const url = 'https://app.example.com/start?tgWebAppStartParam=x#tgWebAppData=abc';
assert.equal(shim.miniAppOrigin(url), 'https://app.example.com', 'the origin comes from the mini app URL');
assert.equal(shim.miniAppOrigin('not a url'), null, 'a malformed URL has no origin');
assert.equal(shim.miniAppOrigin('data:text/html,hi'), null, 'an opaque origin is not an origin');
assert.throws(() => shim.telegramContainerShim(null), /нет домена/, 'the shim is not built without an origin');

const script = shim.telegramContainerShim('https://app.example.com');
const main = run(script, { origin: 'https://app.example.com' });
assert.equal(typeof main.TelegramWebviewProxy?.postEvent, 'function', 'the top frame of the mini app origin gets the container');
let theme = null;
main.Telegram = { WebView: { receiveEvent: (type, data) => { theme = { type, data }; } } };
main.TelegramWebviewProxy.postEvent('web_app_request_theme');
assert.equal(theme?.type, 'theme_changed', 'the container answer reaches WebView.receiveEvent');
assert.equal(theme.data?.theme_params?.bg_color, '#ffffff');

assert.equal(run(script, { origin: 'https://app.example.com', top: false }).TelegramWebviewProxy, undefined, 'a nested frame of the same origin gets no container');
assert.equal(run(script, { origin: 'https://other.example.net' }).TelegramWebviewProxy, undefined, 'a page of another origin gets no container');
assert.equal(run(script, { origin: 'https://other.example.net', top: false }).TelegramWebviewProxy, undefined, 'a frame of another origin gets no container');

// Control: the bare shim body (what used to be injected) gives a foreign frame the container.
const bare = run(shim.TELEGRAM_CONTAINER_SHIM, { origin: 'https://other.example.net', top: false });
assert.equal(typeof bare.TelegramWebviewProxy?.postEvent, 'function', 'control: without the origin check a foreign frame got the container');

// The browser layer injects the origin-bound shim and reports a redirect to another origin.
const browser = readFileSync(join(projectRoot, 'runtime/files/dist/miniapp-browser.js'), 'utf8');
assert.match(browser, /addInitScript\(telegramContainerShim\(miniAppOrigin\(url\)\)\)/, 'openMiniApp injects the origin-bound shim');
assert.doesNotMatch(browser, /addInitScript\(TELEGRAM_CONTAINER_SHIM\)/, 'the unbound shim is not injected');
assert.match(browser, /landed !== expected/, 'openMiniApp compares the landed origin with the mini app origin');
const tools = readFileSync(join(projectRoot, 'runtime/files/dist/tools/miniapps.js'), 'utf8');
assert.match(tools, /Внимание: \$\{openedApp\.warning\}/, 'telegram-open-mini-app with render passes the redirect warning on');

console.log('OK: mini app container shim only in the top frame of the mini app origin, with control and redirect warning');
