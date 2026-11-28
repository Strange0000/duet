// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import LandingPage from '../src/components/LandingPage';

it('uses the bundled artwork when the responsive homepage image fails', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<LandingPage homeTheme="dark" />));
    const image = container.querySelector('.home-hero-art img');
    expect(image.hasAttribute('srcset')).toBe(true);

    act(() => image.dispatchEvent(new Event('error')));

    expect(image.hasAttribute('srcset')).toBe(false);
    expect(image.getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
