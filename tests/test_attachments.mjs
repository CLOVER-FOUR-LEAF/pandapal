import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('const ATTACH_MAX ='), app.indexOf('/** 下载 / 查看原文件'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

class Node extends EventTarget {
  constructor(tag = 'img', classes = '', text = '') {
    super();
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.textContent = text;
    this.isConnected = false;
    this.parentNode = null;
    this.complete = false;
    this.naturalWidth = 0;
    const names = new Set(classes.split(' '));
    this.classList = { add: name => names.add(name), remove: name => names.delete(name),
      contains: name => names.has(name), toggle: (name, on) => on ? names.add(name) : names.delete(name) };
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'src') this.src = ''; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.tagName === selector ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  loaded() { this.complete = true; this.naturalWidth = 900; this.dispatchEvent(new Event('load')); }
  broken() { this.dispatchEvent(new Event('error')); }
}

function harness(request = async () => ({ blob: async () => new Blob(['image'], { type: 'image/png' }) })) {
  let sequence = 0;
  const revoked = [], calls = [], messages = [];
  const state = { token: 'test-token', name: 'test-child', attach: [], attachPending: [] };
  const nodes = new Map([['#lightbox', new Node('div', 'hidden')],
    ['#lightbox-img', new Node()], ['#lightbox-cap', new Node('span')]]);
  const context = vm.createContext({ state, Blob, FormData, URL: {
    createObjectURL: () => `blob:test-${++sequence}`, revokeObjectURL: url => revoked.push(url),
  }, api: async (...args) => { calls.push(args); return request(...args); },
  setTimeout, clearTimeout, Math, Date, encodeURIComponent,
  $: selector => nodes.get(selector), el: (tag, classes, text) => new Node(tag, classes, text),
  icon: () => new Node('svg'), toast: message => messages.push(message), q: () => 'name=test-child',
  downloadAttach() {} });
  vm.runInContext(source, context);
  return { context, state, revoked, calls, messages, nodes };
}

test('a detached thumbnail loads before insertion, including from cache', async () => {
  const h = harness(), first = new Node();
  const pending = h.context.loadPrivateImage(first, '/image', null, true);
  await tick();
  assert.equal(first.isConnected, false);
  assert.match(first.src, /^blob:/);
  assert.equal(first.loading, 'eager');
  first.loaded();
  assert.equal(await pending, true);
  const second = new Node();
  const cached = h.context.loadPrivateImage(second, '/image');
  await tick();
  second.loaded();
  assert.equal(await cached, true);
  assert.equal(h.calls.length, 1);
  assert.notEqual(second.src, first.src);
});

test('redrawing before fetch completes cancels the old node without leaking an object URL', async () => {
  const response = deferred();
  const h = harness(() => response.promise), root = new Node('div'), img = new Node();
  root.appendChild(img);
  const pending = h.context.loadPrivateImage(img, '/image', () => assert.fail('cancel is not failure'));
  h.context.sweepPendingObjectUrls(root);
  response.resolve({ blob: async () => new Blob(['image'], { type: 'image/png' }) });
  assert.equal(await pending, false);
  assert.equal(img.src, undefined);
  assert.equal(h.revoked.length, 0);
});

test('redrawing during decoding releases the URL and resolves the pending load', async () => {
  const h = harness(), root = new Node('div'), img = new Node();
  root.appendChild(img);
  const pending = h.context.loadPrivateImage(img, '/image');
  await tick();
  const url = img.src;
  h.context.sweepPendingObjectUrls(root);
  assert.equal(await pending, false);
  assert.deepEqual(h.revoked, [url]);
  assert.equal(img.src, '');
});

test('invalid image decoding surfaces a reason and retry fetches fresh bytes', async () => {
  const h = harness(), img = new Node();
  let reason = '';
  const pending = h.context.loadPrivateImage(img, '/image', error => { reason = error.message; });
  await tick();
  img.broken();
  assert.equal(await pending, false);
  assert.ok(reason.includes('无法预览'));
  assert.equal(h.revoked.length, 1);
  const retry = h.context.loadPrivateImage(img, '/image');
  await tick();
  img.loaded();
  assert.equal(await retry, true);
  assert.equal(h.calls.length, 2);
});

test('HTML returned instead of an image never becomes a thumbnail', async () => {
  const h = harness(async () => ({ blob: async () => new Blob(['error page'], { type: 'text/html' }) }));
  let reason;
  assert.equal(await h.context.loadPrivateImage(new Node(), '/image', error => { reason = error.message; }), false);
  assert.equal(reason, '未收到图片文件');
});

test('account changes discard an in-flight image and do not reuse its cache', async () => {
  const response = deferred();
  const h = harness(() => response.promise), img = new Node();
  const pending = h.context.loadPrivateImage(img, '/image');
  h.state.token = 'another-token';
  response.resolve({ blob: async () => new Blob(['image'], { type: 'image/png' }) });
  assert.equal(await pending, false);
  assert.equal(img.src, undefined);
  const retry = h.context.loadPrivateImage(img, '/image');
  await tick(); img.loaded();
  assert.equal(await retry, true);
  assert.equal(h.calls.length, 2);
});

test('closing a lightbox during a slow fetch cannot reopen it', async () => {
  const response = deferred(), h = harness(() => response.promise);
  const pending = h.context.openLightbox({ id: 'one', kind: 'image', content: '/image' });
  h.context.closeLightbox();
  response.resolve({ blob: async () => new Blob(['image'], { type: 'image/png' }) });
  await pending;
  assert.equal(h.nodes.get('#lightbox').classList.contains('hidden'), true);
  assert.equal(h.state.lightboxFile, null);
});

test('a broken message preview shows retry and becomes ready after retry succeeds', async () => {
  const h = harness();
  const row = h.context.filesRow([{ id: 'one', kind: 'image', name: 'photo.png', content: '/image' }]);
  const card = row.children[0], img = card.querySelectorAll('img')[0];
  assert.equal(card.dataset.imageState, 'loading');
  await tick(); img.broken(); await tick();
  assert.equal(card.dataset.imageState, 'error');
  assert.ok(card.children.some(child => child.textContent.includes('点击重试')));
  card.onclick({ preventDefault() {} });
  await tick(); img.loaded(); await tick();
  assert.equal(card.dataset.imageState, 'ready');
  assert.equal(card.attributes['aria-busy'], 'false');
  assert.equal(h.calls.length, 2);
});

test('removing a reused attachment never deletes the historical image', () => {
  const h = harness();
  h.state.attach.push({ id: 'historical-image' });
  h.context.removeAttach('historical-image');
  assert.equal(h.state.attach.length, 0);
  assert.equal(h.calls.length, 0);
});

test('oversized and failed uploads retain a visible error instead of disappearing', async () => {
  const h = harness(async () => { throw new Error('上传失败'); });
  await h.context.uploadFiles([{ name: 'oversized.png', size: 11 * 1024 * 1024 }]);
  assert.equal(h.state.attachPending.length, 1);
  assert.ok(h.state.attachPending[0].error.includes('10MB'));
  assert.equal(h.messages.length, 1);
  await h.context.uploadFiles([new File(['image'], 'broken.png', { type: 'image/png' })]);
  assert.equal(h.state.attachPending.length, 2);
  assert.equal(h.state.attachPending[1].error, '上传失败');
  assert.equal(h.state.attach.length, 0);
});
