import vm from 'node:vm';

function attributesFrom(source) {
  const attributes = new Map();
  const pattern = /([a-zA-Z][\w:-]*)(?:="([^"]*)")?/g;
  for (const match of source.matchAll(pattern)) {
    attributes.set(match[1], match[2] === undefined ? '' : match[2]);
  }
  return attributes;
}

function visibleText(source) {
  return String(source).replace(/<[^>]+>/g, '').trim();
}

class BrowserElement {
  constructor(document, tagName, attributes = new Map(), text = '') {
    this.document = document;
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
    this.children = [];
    this.disabled = attributes.has('disabled');
    this.id = attributes.get('id') || '';
    this.onclick = null;
    this.textContent = text;
    this.value = '';
    this._innerHTML = '';
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.textContent = visibleText(this._innerHTML);
    if (this.id === 'app') this.document.render(this._innerHTML);
  }

  async click() {
    if (this.disabled || typeof this.onclick !== 'function') return;
    return this.onclick({ currentTarget: this, target: this });
  }

  focus() {
    this.document.activeElement = this;
  }
}

class BrowserDocument {
  constructor() {
    this.app = new BrowserElement(
      this,
      'main',
      new Map([['id', 'app'], ['aria-live', 'polite']])
    );
    this.elements = new Map([['app', this.app]]);
    this.navigation = null;
    this.buttons = [];
    this.activeElement = null;
  }

  getElementById(id) {
    return this.elements.get(id) || null;
  }

  querySelector(selector) {
    const navigation = String(selector).match(
      /^nav\[aria-label="([^"]+)"\]$/
    );
    if (!navigation || !this.navigation) return null;
    return this.navigation.getAttribute('aria-label') === navigation[1]
      ? this.navigation
      : null;
  }

  render(html) {
    this.elements = new Map([['app', this.app]]);
    this.navigation = null;
    this.buttons = [];

    const startTag = /<([a-z][\w-]*)\b([^>]*)>/gi;
    for (const match of html.matchAll(startTag)) {
      const attributes = attributesFrom(match[2]);
      const id = attributes.get('id');
      const afterTag = html.slice(match.index + match[0].length);
      const closePattern = new RegExp('^([\\s\\S]*?)<\\/' + match[1] + '>', 'i');
      const body = (afterTag.match(closePattern) || afterTag.match(/^([^<]*)/) || ['', ''])[1];
      const text = visibleText(body);
      const element = new BrowserElement(this, match[1], attributes, text);
      if (id) this.elements.set(id, element);
      if (match[1].toLowerCase() === 'button') this.buttons.push(element);
    }

    const navigation = html.match(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/i);
    if (!navigation) return;
    this.navigation = new BrowserElement(
      this,
      'nav',
      attributesFrom(navigation[1])
    );
    const buttons = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
    for (const button of navigation[2].matchAll(buttons)) {
      this.navigation.children.push(new BrowserElement(
        this,
        'button',
        attributesFrom(button[1]),
        visibleText(button[2])
      ));
    }
  }
}

async function settle() {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function executeManageClient(source, {
  fetch,
  pathname = '/manage',
  online = true
}) {
  const document = new BrowserDocument();
  const serviceWorkerRegistrations = [];
  const listeners = new Map();
  const timers = new Map();
  let timerId = 0;
  let now = 0;
  const navigator = {
    onLine: online,
    serviceWorker: {
      async register(path) {
        serviceWorkerRegistrations.push(path);
        return { scope: path };
      }
    }
  };
  const location = { pathname };
  const window = {
    document,
    navigator,
    location,
    addEventListener(type, listener) {
      const group = listeners.get(type) || [];
      group.push(listener);
      listeners.set(type, group);
    },
    setInterval(callback, delay) {
      timerId += 1;
      timers.set(timerId, { callback, delay, next: now + delay });
      return timerId;
    },
    clearInterval(id) {
      timers.delete(id);
    }
  };
  const browser = vm.createContext({
    console,
    document,
    fetch,
    location,
    navigator,
    window,
    URLSearchParams,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval
  });

  vm.runInContext(source, browser, { filename: '/manage/app.js' });
  await settle();

  return {
    document,
    serviceWorkerRegistrations,
    async clickButton(label) {
      const button = document.buttons.find((item) => item.textContent === label);
      if (!button) throw new Error(`button_not_found:${label}`);
      await button.click();
      await settle();
    },
    navigationLabels() {
      return document.navigation
        ? Array.from(document.navigation.children, (button) => button.textContent)
        : [];
    },
    async setOnline(value) {
      navigator.onLine = value;
      for (const listener of listeners.get(value ? 'online' : 'offline') || []) {
        listener();
      }
      await settle();
    },
    async advanceTimers(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const due = Array.from(timers.entries())
          .filter(([, timer]) => timer.next <= target)
          .sort((left, right) => left[1].next - right[1].next)[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.next;
        await timer.callback();
        if (timers.has(id)) timer.next += timer.delay;
        await settle();
      }
      now = target;
    },
    async call(name, ...args) {
      if (typeof browser[name] !== 'function') throw new Error(`function_not_found:${name}`);
      const result = await browser[name](...args);
      await settle();
      return result;
    }
  };
}
