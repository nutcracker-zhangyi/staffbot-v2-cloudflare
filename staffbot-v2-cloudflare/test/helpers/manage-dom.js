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
    if (this.id === 'app') this.document.render(this._innerHTML);
  }

  async click() {
    if (this.disabled || typeof this.onclick !== 'function') return;
    return this.onclick({ currentTarget: this, target: this });
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

    const startTag = /<([a-z][\w-]*)\b([^>]*)>/gi;
    for (const match of html.matchAll(startTag)) {
      const attributes = attributesFrom(match[2]);
      const id = attributes.get('id');
      if (!id) continue;
      const afterTag = html.slice(match.index + match[0].length);
      const text = visibleText((afterTag.match(/^([^<]*)/) || ['', ''])[1]);
      this.elements.set(
        id,
        new BrowserElement(this, match[1], attributes, text)
      );
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

export async function executeManageClient(source, { fetch }) {
  const document = new BrowserDocument();
  const serviceWorkerRegistrations = [];
  const navigator = {
    serviceWorker: {
      async register(path) {
        serviceWorkerRegistrations.push(path);
        return { scope: path };
      }
    }
  };
  const browser = vm.createContext({
    console,
    document,
    fetch,
    navigator
  });

  vm.runInContext(source, browser, { filename: '/manage/app.js' });
  await settle();

  return {
    document,
    serviceWorkerRegistrations
  };
}
