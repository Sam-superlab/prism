'use client';

import { useEffect } from 'react';

const buttonSelector = 'button, summary, [role="button"], [role="switch"], a:is(.button, .icon-button, .nav-link, [title]), input:is([type="button"], [type="submit"], [type="reset"], [type="image"])';
const hoverDelay = 220;
const dismissDelay = 130;
const fadeDuration = 160;

function buttonAt(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLElement>(buttonSelector) : null;
}

function buttonName(button: HTMLElement) {
  if (button.dataset.tooltip === 'off') return undefined;
  const labelledBy = button.getAttribute('aria-labelledby')?.trim().split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent).filter(Boolean).join(' ');
  const label = button instanceof HTMLInputElement ? (button.labels?.[0]?.innerText || button.alt ||
    (button.getAttribute('role') === 'switch' ? undefined : button.value)) : button.innerText;
  return [button.dataset.tooltip, button.getAttribute('title'), labelledBy, button.getAttribute('aria-label'), label]
    .map((value) => value?.replace(/\s+/g, ' ').trim()).find(Boolean);
}

function hasVisibleText(button: HTMLElement) {
  if (button instanceof HTMLInputElement) return button.type !== 'image';
  const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!node.textContent?.trim() || !parent || parent.closest('svg, [aria-hidden="true"]')) continue;
    if (parent.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false &&
        getComputedStyle(parent).display !== 'contents') continue;
    if (parent !== button && parent.clientWidth === 1 && parent.clientHeight === 1) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    if ([...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0)) return true;
  }
  return false;
}

export function ButtonTooltips() {
  useEffect(() => {
    const bubble = document.createElement('div');
    bubble.className = 'button-tooltip';
    // The control retains its own accessible name. This visual copy adds no announcement.
    bubble.setAttribute('aria-hidden', 'true');
    const popover = typeof bubble.showPopover === 'function';
    if (popover) bubble.setAttribute('popover', 'manual');

    let anchor: HTMLElement | null = null;
    let nativeTitle: string | null = null;
    let showTimer = 0;
    let dismissTimer = 0;
    let removeTimer = 0;
    let positionFrame = 0;
    let source: 'pointer' | 'focus' = 'pointer';

    function unmountBubble() {
      if (popover && bubble.isConnected && bubble.matches(':popover-open')) bubble.hidePopover();
      bubble.remove();
    }

    function placeBubble() {
      if (!anchor?.isConnected || !anchor.getClientRects().length) return false;
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft ?? 0;
      const y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const margin = 8;
      const gap = 6;
      if (rect.bottom <= y || rect.top >= y + height || rect.right <= x || rect.left >= x + width) return false;

      const tipWidth = bubble.offsetWidth;
      const tipHeight = bubble.offsetHeight;
      const above = rect.top - gap - tipHeight >= y + margin && rect.bottom + gap + tipHeight > y + height - margin;
      const left = Math.max(x + margin, Math.min(rect.left + (rect.width - tipWidth) / 2, x + width - margin - tipWidth));
      const targetTop = above ? rect.top - gap - tipHeight : rect.bottom + gap;
      const top = Math.max(y + margin, Math.min(targetTop, y + height - margin - tipHeight));
      bubble.dataset.side = above ? 'above' : 'below';
      bubble.style.left = `${Math.round(left)}px`;
      bubble.style.top = `${Math.round(top)}px`;
      return true;
    }

    function hide() {
      window.clearTimeout(showTimer);
      window.clearTimeout(dismissTimer);
      if (anchor?.getAttribute('title') === '' && nativeTitle) anchor.setAttribute('title', nativeTitle);
      anchor = null;
      nativeTitle = null;
      observer.disconnect();
      window.cancelAnimationFrame(positionFrame);
      if (!bubble.isConnected) return;
      delete bubble.dataset.visible;
      window.clearTimeout(removeTimer);
      removeTimer = window.setTimeout(unmountBubble, fadeDuration);
    }

    const observer = new MutationObserver(() => {
      if (anchor && (!anchor.isConnected || anchor.closest('[hidden], dialog:not([open])') ||
        !anchor.getClientRects().length)) hide();
    });

    function show(button: HTMLElement, origin: typeof source) {
      window.clearTimeout(dismissTimer);
      if (anchor === button) {
        source = origin;
        return;
      }
      hide();
      const label = buttonName(button);
      if (!label && !button.hasAttribute('title')) return;
      anchor = button;
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });
      source = origin;
      nativeTitle = button.getAttribute('title');
      if (nativeTitle) button.setAttribute('title', '');
      if (!label || hasVisibleText(button)) return;
      showTimer = window.setTimeout(() => {
        if (anchor !== button || !button.isConnected || !button.getClientRects().length) return hide();
        if (hasVisibleText(button)) return;
        window.clearTimeout(removeTimer);
        const host = (popover ? button.closest('dialog:modal') : button.closest('dialog[open]')) ??
          document.fullscreenElement ?? document.body;
        if (bubble.parentElement !== host) {
          unmountBubble();
          host.append(bubble);
        }
        if (popover && !bubble.matches(':popover-open')) bubble.showPopover();
        bubble.textContent = label;
        if (placeBubble()) {
          // Measuring the hidden bubble establishes the starting opacity and position.
          bubble.dataset.visible = 'true';
        }
        else hide();
      }, origin === 'pointer' ? hoverDelay : 0);
    }

    function pointerOver(event: PointerEvent) {
      if (event.pointerType === 'touch') return;
      if (event.target === bubble) {
        window.clearTimeout(dismissTimer);
        return;
      }
      const button = buttonAt(event.target);
      if (button) show(button, 'pointer');
    }

    function pointerMove(event: PointerEvent) {
      if (event.pointerType === 'touch' || event.target === bubble) return;
      const button = buttonAt(event.target);
      if (button && !anchor) show(button, 'pointer');
    }

    function pointerOut(event: PointerEvent) {
      if (event.pointerType === 'touch' || source !== 'pointer' || !anchor) return;
      if (event.target !== bubble && buttonAt(event.target) !== anchor) return;
      if (event.relatedTarget === bubble || buttonAt(event.relatedTarget) === anchor) return;
      window.clearTimeout(dismissTimer);
      dismissTimer = window.setTimeout(hide, bubble.dataset.visible ? dismissDelay : 0);
    }

    function focusIn(event: FocusEvent) {
      const button = buttonAt(event.target);
      if (button?.matches(':focus-visible')) show(button, 'focus');
      else if (source === 'focus') hide();
    }

    function focusOut(event: FocusEvent) {
      if (source === 'focus' && anchor === buttonAt(event.target)) hide();
    }

    function reposition() {
      if (!bubble.dataset.visible) return;
      window.cancelAnimationFrame(positionFrame);
      positionFrame = window.requestAnimationFrame(() => { if (!placeBubble()) hide(); });
    }

    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') hide();
    }

    document.addEventListener('pointerover', pointerOver, true);
    document.addEventListener('pointerout', pointerOut, true);
    document.addEventListener('pointermove', pointerMove, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('focusin', focusIn, true);
    document.addEventListener('focusout', focusOut, true);
    document.addEventListener('keydown', dismissOnEscape, true);
    document.addEventListener('scroll', reposition, true);
    window.addEventListener('blur', hide);
    window.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('resize', reposition);

    return () => {
      document.removeEventListener('pointerover', pointerOver, true);
      document.removeEventListener('pointerout', pointerOut, true);
      document.removeEventListener('pointermove', pointerMove, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('focusin', focusIn, true);
      document.removeEventListener('focusout', focusOut, true);
      document.removeEventListener('keydown', dismissOnEscape, true);
      document.removeEventListener('scroll', reposition, true);
      window.removeEventListener('blur', hide);
      window.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('resize', reposition);
      hide();
      window.clearTimeout(removeTimer);
      unmountBubble();
    };
  }, []);

  return null;
}
