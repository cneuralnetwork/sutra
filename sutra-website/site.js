/* Sutra website: theme, navigation, copy buttons, reveal, analytics. */

/* Set this to your Plausible domain, for example 'sutra.dev', to enable
   privacy-friendly analytics. Leave it empty to load no third-party script. */
const PLAUSIBLE_DOMAIN = '';
const PLAUSIBLE_SCRIPT_URL = 'https://plausible.io/js/script.js';

const root = document.documentElement;
const themeToggle = document.querySelector('[data-theme-toggle]');
const themeQuery = window.matchMedia('(prefers-color-scheme: light)');

function storedTheme() {
  try {
    const value = localStorage.getItem('sutra-theme');
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    return null;
  }
}

function syncThemeButton() {
  if (!themeToggle) return;
  const isDark = root.dataset.theme !== 'light';
  themeToggle.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
}

function setTheme(theme, persist) {
  root.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem('sutra-theme', theme);
    } catch {
      // A blocked storage API should not break the page.
    }
  }
  syncThemeButton();
}

syncThemeButton();

themeToggle?.addEventListener('click', () => {
  setTheme(root.dataset.theme === 'light' ? 'dark' : 'light', true);
});

themeQuery.addEventListener('change', (event) => {
  if (storedTheme()) return;
  setTheme(event.matches ? 'light' : 'dark', false);
});

/* Header state and mobile navigation. */

const header = document.querySelector('[data-site-header]');
const navToggle = document.querySelector('[data-nav-toggle]');

function setNavOpen(open) {
  if (!header || !navToggle) return;
  header.classList.toggle('nav-open', open);
  navToggle.setAttribute('aria-expanded', String(open));
  navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}

navToggle?.addEventListener('click', () => {
  setNavOpen(!header?.classList.contains('nav-open'));
});

document.querySelectorAll('[data-nav-link]').forEach((link) => {
  link.addEventListener('click', () => setNavOpen(false));
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setNavOpen(false);
});

document.addEventListener('click', (event) => {
  if (!header?.classList.contains('nav-open')) return;
  if (event.target instanceof Node && header.contains(event.target)) return;
  setNavOpen(false);
});

window.addEventListener('resize', () => {
  if (window.innerWidth > 900) setNavOpen(false);
});

function syncHeader() {
  header?.classList.toggle('is-scrolled', window.scrollY > 8);
}

syncHeader();
window.addEventListener('scroll', syncHeader, { passive: true });

/* Keep the footer year current without a build step. */
document.querySelectorAll('[data-year]').forEach((el) => {
  el.textContent = String(new Date().getFullYear());
});

/* Copy-to-clipboard buttons. */

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

document.querySelectorAll('[data-copy]').forEach((button) => {
  const label = button.querySelector('[data-copy-label]');
  const original = label?.textContent ?? 'Copy';

  button.addEventListener('click', async () => {
    const code = button.closest('.code-block')?.querySelector('code')?.textContent ?? '';
    if (!code) return;

    const ok = await copyText(code);
    if (label) label.textContent = ok ? 'Copied' : 'Failed';
    button.classList.toggle('is-copied', ok);

    window.setTimeout(() => {
      if (label) label.textContent = original;
      button.classList.remove('is-copied');
    }, 1600);
  });
});

/* Reveal elements as they enter the viewport. */

const revealItems = Array.from(document.querySelectorAll('.reveal'));
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (reducedMotion || !('IntersectionObserver' in window)) {
  revealItems.forEach((item) => item.classList.add('is-visible'));
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
  );

  revealItems.forEach((item) => observer.observe(item));
}

/* Privacy-friendly conversion events. */

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const target = event.target.closest('[data-analytics]');
  if (!target) return;

  const eventName = target.dataset.analytics;
  if (!eventName) return;

  window.plausible?.(eventName, {
    props: { page: window.location.pathname },
  });
});

/* Analytics stays off unless a domain is configured above. */
if (PLAUSIBLE_DOMAIN) {
  window.plausible =
    window.plausible ||
    function () {
      (window.plausible.q = window.plausible.q || []).push(arguments);
    };

  const script = document.createElement('script');
  script.defer = true;
  script.dataset.domain = PLAUSIBLE_DOMAIN;
  script.src = PLAUSIBLE_SCRIPT_URL;
  document.head.append(script);
}
